// Read-only database assertions for the integration tests: only SELECT statements, only on the verified test database
// (integrationEnv.query enforces both). They return plain values, so a test can compare "before" and "after".
const { query } = require('./integrationEnv');

const TABLES = [
  'admins',
  'customers',
  'products',
  'orders',
  'order_items',
  'order_status_history',
  'stock_adjustments',
  'audit_log',
  'app_settings',
];

async function countRows(table) {
  if (!TABLES.includes(table)) {
    throw new Error(`Unknown table: ${table}`);
  }
  const rows = await query(`SELECT COUNT(*) AS n FROM \`${table}\``); // table name comes from the list above
  return Number(rows[0].n);
}

// { orders: 0, order_items: 0, ... } for the given tables. Compare two snapshots to prove "nothing was written".
async function countsOf(tables) {
  const counts = {};
  for (const table of tables) {
    counts[table] = await countRows(table);
  }
  return counts;
}

async function productStock(productId) {
  const rows = await query('SELECT stock_quantity FROM products WHERE id = ?', [productId]);
  return rows.length > 0 ? Number(rows[0].stock_quantity) : null;
}

// { id, status, customerId, totalAmount } or null.
async function orderRow(orderId) {
  const rows = await query('SELECT id, customer_id, status, total_amount FROM orders WHERE id = ?', [orderId]);
  if (rows.length === 0) return null;
  return {
    id: Number(rows[0].id),
    customerId: Number(rows[0].customer_id),
    status: rows[0].status,
    totalAmount: String(rows[0].total_amount),
  };
}

async function orderItems(orderId) {
  const rows = await query(
    'SELECT product_id, quantity, unit_price FROM order_items WHERE order_id = ? ORDER BY id ASC',
    [orderId]
  );
  return rows.map((row) => ({
    productId: Number(row.product_id),
    quantity: Number(row.quantity),
    unitPrice: String(row.unit_price),
  }));
}

async function orderHistory(orderId) {
  const rows = await query(
    `SELECT from_status, to_status, changed_by_admin_id
       FROM order_status_history WHERE order_id = ? ORDER BY id ASC`,
    [orderId]
  );
  return rows.map((row) => ({
    fromStatus: row.from_status,
    toStatus: row.to_status,
    changedByAdminId: Number(row.changed_by_admin_id),
  }));
}

function toMovement(row) {
  return {
    id: Number(row.id),
    productId: Number(row.product_id),
    quantityDelta: Number(row.quantity_delta),
    reason: row.reason,
    adminId: Number(row.admin_id),
    orderId: row.order_id === null ? null : Number(row.order_id),
    movementType: row.movement_type,
  };
}

const MOVEMENT_COLUMNS = 'id, product_id, quantity_delta, reason, admin_id, order_id, movement_type';

// The stock_adjustments rows caused by one order, lowest product id first.
async function movementsForOrder(orderId) {
  const rows = await query(
    `SELECT ${MOVEMENT_COLUMNS} FROM stock_adjustments WHERE order_id = ? ORDER BY product_id ASC, id ASC`,
    [orderId]
  );
  return rows.map(toMovement);
}

// Every stock_adjustments row of one product (manual and order movements), oldest first.
async function movementsForProduct(productId) {
  const rows = await query(
    `SELECT ${MOVEMENT_COLUMNS} FROM stock_adjustments WHERE product_id = ? ORDER BY id ASC`,
    [productId]
  );
  return rows.map(toMovement);
}

// An administrator's stored account. password_hash is returned so a test can tell whether it CHANGED (compare with
// !==, then assert on the boolean: never put the hash itself in an expect, so a failure cannot print it).
async function adminRow(adminId) {
  const rows = await query(
    'SELECT id, email, display_name, password_hash, is_active, token_version FROM admins WHERE id = ?',
    [adminId]
  );
  if (rows.length === 0) return null;
  return {
    id: Number(rows[0].id),
    email: rows[0].email,
    displayName: rows[0].display_name,
    passwordHash: rows[0].password_hash,
    isActive: Boolean(rows[0].is_active),
    tokenVersion: Number(rows[0].token_version),
  };
}

// The ids of an order's status-history rows, oldest first.
async function historyIds(orderId) {
  const rows = await query('SELECT id FROM order_status_history WHERE order_id = ? ORDER BY id ASC', [orderId]);
  return rows.map((row) => Number(row.id));
}

// Every audit_log row, oldest first, with details as an object (or null).
async function auditRows() {
  const rows = await query(
    'SELECT id, admin_id, event_type, entity_type, entity_id, details FROM audit_log ORDER BY id ASC'
  );
  return rows.map((row) => ({
    id: Number(row.id),
    adminId: Number(row.admin_id),
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id === null ? null : Number(row.entity_id),
    details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details,
  }));
}

// One app_settings row as { value, updatedByAdminId }, or null when the setting has never been saved.
async function settingRow(key) {
  const rows = await query(
    'SELECT setting_value, updated_by_admin_id FROM app_settings WHERE setting_key = ?',
    [key]
  );
  if (rows.length === 0) return null;
  return {
    value: String(rows[0].setting_value),
    updatedByAdminId: rows[0].updated_by_admin_id === null ? null : Number(rows[0].updated_by_admin_id),
  };
}

module.exports = {
  TABLES,
  adminRow,
  historyIds,
  auditRows,
  settingRow,
  countRows,
  countsOf,
  productStock,
  orderRow,
  orderItems,
  orderHistory,
  movementsForOrder,
  movementsForProduct,
};
