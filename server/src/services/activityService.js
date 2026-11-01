// Turns the rows of the three activity sources into one list of events, newest first.
// Nothing is invented: every event comes from a stored row, with the administrator who made it and the time it was stored.
const activityRepository = require('../repositories/activityRepository');
const { DETAIL_SCHEMAS } = require('../validation/auditSchemas');

function toActor(row) {
  return { id: Number(row.admin_id), email: row.admin_email, displayName: row.admin_display_name ?? null };
}

// order_status_history: the first row of an order (no from_status) is "created"; every later row is the new status.
function orderEventType(row) {
  return row.from_status ? `ORDER_${row.to_status}` : 'ORDER_CREATED';
}

// A confirmed order deducted stock and a cancelled one may have restored it. Those movements are shown inside the
// matching order event. Other order events (created, shipped, delivered) never touch stock.
const MOVEMENT_FOR_EVENT = { ORDER_CONFIRMED: 'ORDER_CONFIRMED', ORDER_CANCELLED: 'ORDER_CANCELLED' };

function toOrderEvent(row, movements) {
  const type = orderEventType(row);
  const wanted = MOVEMENT_FOR_EVENT[type];
  return {
    id: `order-${Number(row.id)}`,
    type,
    occurredAt: row.changed_at,
    actor: toActor(row),
    entity: { type: 'order', id: Number(row.order_id), label: `Order #${Number(row.order_id)}` },
    details: {
      fromStatus: row.from_status ?? null,
      toStatus: row.to_status,
      customerName: row.customer_name,
      totalAmount: String(row.total_amount),
      stockMovements: wanted
        ? movements
            .filter((m) => Number(m.order_id) === Number(row.order_id) && m.movement_type === wanted)
            .map((m) => ({ productId: Number(m.product_id), sku: m.sku, productName: m.product_name, quantityDelta: Number(m.quantity_delta) }))
        : [],
    },
  };
}

function toStockEvent(row) {
  return {
    id: `stock-${Number(row.id)}`,
    type: 'STOCK_ADJUSTED',
    occurredAt: row.created_at,
    actor: toActor(row),
    entity: { type: 'product', id: Number(row.product_id), label: `${row.sku} — ${row.product_name}` },
    details: {
      productId: Number(row.product_id),
      sku: row.sku,
      productName: row.product_name,
      quantityDelta: Number(row.quantity_delta),
      reason: row.reason,
    },
  };
}

// The stored JSON is checked against the audit allowlist again on the way out, so nothing outside it is ever shown,
// even if a row was written some other way. Anything that does not pass is shown as "no details".
function safeAuditDetails(eventType, stored) {
  let value = stored;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (err) {
      return null;
    }
  }
  const schema = DETAIL_SCHEMAS[eventType];
  const parsed = schema ? schema.safeParse(value ?? null) : null;
  return parsed && parsed.success ? parsed.data : null;
}

function auditEntity(row) {
  const id = row.entity_id === null || row.entity_id === undefined ? null : Number(row.entity_id);
  switch (row.entity_type) {
    case 'PRODUCT':
      return { type: 'product', id, label: row.product_sku ? `${row.product_sku} — ${row.product_name}` : `Product #${id}` };
    case 'CUSTOMER':
      return { type: 'customer', id, label: row.customer_name ?? `Customer #${id}` };
    case 'ACCOUNT':
      return { type: 'account', id, label: 'Administrator account' };
    default:
      return { type: 'settings', id: null, label: 'Settings' };
  }
}

function toAuditEvent(row) {
  return {
    id: `audit-${Number(row.id)}`,
    type: row.event_type,
    occurredAt: row.occurred_at,
    actor: toActor(row),
    entity: auditEntity(row),
    details: safeAuditDetails(row.event_type, row.details),
  };
}

const idsFor = (keys, source) => keys.filter((key) => key.source === source).map((key) => key.id);

// query: { q, type, from, to, page, pageSize } as validated by activityQuerySchema.
async function listActivity(query) {
  const { keys, total } = await activityRepository.listKeys(query);

  const [orderRows, stockRows, auditRows] = await Promise.all([
    activityRepository.fetchOrderEvents(idsFor(keys, 'order')),
    activityRepository.fetchStockEvents(idsFor(keys, 'stock')),
    activityRepository.fetchAuditEvents(idsFor(keys, 'audit')),
  ]);
  const orderIds = [...new Set(orderRows.map((row) => Number(row.order_id)))];
  const movements = await activityRepository.fetchOrderStockMovements(orderIds);

  const events = new Map();
  for (const row of orderRows) events.set(`order:${Number(row.id)}`, toOrderEvent(row, movements));
  for (const row of stockRows) events.set(`stock:${Number(row.id)}`, toStockEvent(row));
  for (const row of auditRows) events.set(`audit:${Number(row.id)}`, toAuditEvent(row));

  // Keep the order the keys query decided. A row that vanished in between is skipped, not invented.
  const items = keys.map((key) => events.get(`${key.source}:${key.id}`)).filter(Boolean);
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

module.exports = { listActivity };
