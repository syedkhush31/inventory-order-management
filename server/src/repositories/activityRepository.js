// All SQL for the Activity page. READ-ONLY: it only SELECTs. The activity history is built from three places:
//   order    order_status_history      who changed an order's status, and when (the first row is "order created")
//   stock    stock_adjustments         MANUAL rows only. Order-related stock movements (ORDER_CONFIRMED / ORDER_CANCELLED)
//                                      are read separately and shown INSIDE their order event, never as their own rows
//   audit    audit_log                 product, customer, account and settings changes recorded since migration 003
// Nothing is reconstructed from updated_at columns, and nothing is backfilled.
//
// Strategy: one "keys" query filters, orders and pages across the sources (only source, id and time per row), then each
// source is asked for the full rows of just that page. Only fixed SQL text is built here; user input is always a ? value.
const { getPool } = require('../config/db');

const SOURCES = { order: 1, stock: 2, audit: 3 };
const AUDIT_ENTITY_BY_TYPE = { product: 'PRODUCT', customer: 'CUSTOMER', account: 'ACCOUNT', settings: 'SETTINGS' };

// "!" is the LIKE escape character, so no backslashes are involved.
function escapeLike(text) {
  return text.replace(/[!%_]/g, (char) => `!${char}`);
}

function assertSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

// Which sources a type filter reads.
function sourcesFor(type) {
  if (type === 'all') return ['order', 'stock', 'audit'];
  if (type === 'order' || type === 'stock') return [type];
  if (AUDIT_ENTITY_BY_TYPE[type]) return ['audit'];
  throw new Error('Unsupported activity type');
}

// Conditions shared by every source: the date range on that source's time column, and the search on the given
// columns. adminColumns are always searched too, so "ann@example.com" finds what that administrator did.
function commonConditions({ q, from, to }, timeColumn, searchColumns, extraSearch) {
  const conditions = [];
  const values = [];
  if (from) {
    conditions.push(`${timeColumn} >= ?`);
    values.push(new Date(from));
  }
  if (to) {
    conditions.push(`${timeColumn} < ?`);
    values.push(new Date(to));
  }
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    const parts = [...searchColumns, 'a.email', 'a.display_name'].map((column) => `${column} LIKE ? ESCAPE '!'`);
    values.push(...[...searchColumns, 'a.email', 'a.display_name'].map(() => pattern));
    const extra = extraSearch ? extraSearch(q) : null;
    if (extra) {
      parts.push(extra.sql);
      values.push(...extra.values);
    }
    conditions.push(`(${parts.join(' OR ')})`);
  }
  return { conditions, values };
}

// One SELECT per source with the same four columns, so they can be combined with UNION ALL.
function buildBranch(source, query) {
  if (source === 'order') {
    const { conditions, values } = commonConditions(query, 'h.changed_at', ['c.name'], (q) => {
      const idMatch = /^#?([1-9]\d{0,14})$/.exec(q); // "12" or "#12" also finds order 12
      return idMatch ? { sql: 'h.order_id = ?', values: [Number(idMatch[1])] } : null;
    });
    return {
      sql: `SELECT 'order' AS source, ${SOURCES.order} AS source_rank, h.id AS source_id, h.changed_at AS occurred_at
              FROM order_status_history h
              JOIN orders o ON o.id = h.order_id
              JOIN customers c ON c.id = o.customer_id
              JOIN admins a ON a.id = h.changed_by_admin_id
             ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}`,
      values,
    };
  }

  if (source === 'stock') {
    const { conditions, values } = commonConditions(query, 'sa.created_at', ['p.sku', 'p.name']);
    return {
      sql: `SELECT 'stock' AS source, ${SOURCES.stock} AS source_rank, sa.id AS source_id, sa.created_at AS occurred_at
              FROM stock_adjustments sa
              JOIN products p ON p.id = sa.product_id
              JOIN admins a ON a.id = sa.admin_id
             WHERE sa.movement_type = 'MANUAL'${conditions.length ? ` AND ${conditions.join(' AND ')}` : ''}`,
      values,
    };
  }

  const { conditions, values } = commonConditions(query, 'al.occurred_at', ['p.sku', 'p.name', 'c.name']);
  const entityType = AUDIT_ENTITY_BY_TYPE[query.type];
  if (entityType) {
    conditions.unshift('al.entity_type = ?');
    values.unshift(entityType);
  }
  return {
    sql: `SELECT 'audit' AS source, ${SOURCES.audit} AS source_rank, al.id AS source_id, al.occurred_at AS occurred_at
            FROM audit_log al
            JOIN admins a ON a.id = al.admin_id
            LEFT JOIN products p ON al.entity_type = 'PRODUCT' AND p.id = al.entity_id
            LEFT JOIN customers c ON al.entity_type = 'CUSTOMER' AND c.id = al.entity_id
           ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}`,
    values,
  };
}

// The UNION ALL of the sources a query needs, with the values for its placeholders in order.
function buildUnion(query) {
  const branches = sourcesFor(query.type).map((source) => buildBranch(source, query));
  return {
    sql: branches.map((branch) => `(${branch.sql})`).join(' UNION ALL '),
    values: branches.flatMap((branch) => branch.values),
  };
}

// Returns { keys: [{ source, id, occurredAt }], total } for one page, newest first. The tie-break (source, then id)
// is fixed so rows never jump between pages.
async function listKeys(query) {
  const offset = (query.page - 1) * query.pageSize;
  assertSafeInteger(query.pageSize, 'pageSize');
  assertSafeInteger(offset, 'offset');

  const union = buildUnion(query);
  const pool = getPool();
  const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM (${union.sql}) AS k`, union.values);
  const [rows] = await pool.query(
    `SELECT source, source_id, occurred_at FROM (${union.sql}) AS k
      ORDER BY occurred_at DESC, source_rank ASC, source_id DESC
      LIMIT ? OFFSET ?`,
    [...union.values, query.pageSize, offset]
  );
  return {
    keys: rows.map((row) => ({ source: row.source, id: Number(row.source_id), occurredAt: row.occurred_at })),
    total: Number(countRows[0].total),
  };
}

const ADMIN_COLUMNS = 'a.id AS admin_id, a.email AS admin_email, a.display_name AS admin_display_name';

// Full rows for the order events on a page (ids are order_status_history ids).
async function fetchOrderEvents(ids) {
  if (ids.length === 0) return [];
  const [rows] = await getPool().query(
    `SELECT h.id, h.order_id, h.from_status, h.to_status, h.changed_at, c.name AS customer_name, o.total_amount, ${ADMIN_COLUMNS}
       FROM order_status_history h
       JOIN orders o ON o.id = h.order_id
       JOIN customers c ON c.id = o.customer_id
       JOIN admins a ON a.id = h.changed_by_admin_id
      WHERE h.id IN (?)`,
    [ids]
  );
  return rows;
}

// The stock movements caused by orders, to be shown inside their order events. Never listed on their own.
async function fetchOrderStockMovements(orderIds) {
  if (orderIds.length === 0) return [];
  const [rows] = await getPool().query(
    `SELECT sa.id, sa.order_id, sa.movement_type, sa.product_id, p.sku, p.name AS product_name, sa.quantity_delta
       FROM stock_adjustments sa
       JOIN products p ON p.id = sa.product_id
      WHERE sa.order_id IN (?) AND sa.movement_type IN ('ORDER_CONFIRMED', 'ORDER_CANCELLED')
      ORDER BY sa.id ASC`,
    [orderIds]
  );
  return rows;
}

// Full rows for the manual stock corrections on a page (MANUAL only).
async function fetchStockEvents(ids) {
  if (ids.length === 0) return [];
  const [rows] = await getPool().query(
    `SELECT sa.id, sa.created_at, sa.product_id, p.sku, p.name AS product_name, sa.quantity_delta, sa.reason, ${ADMIN_COLUMNS}
       FROM stock_adjustments sa
       JOIN products p ON p.id = sa.product_id
       JOIN admins a ON a.id = sa.admin_id
      WHERE sa.id IN (?) AND sa.movement_type = 'MANUAL'`,
    [ids]
  );
  return rows;
}

// Full rows for the audit events on a page. Product and customer names come from a live join for display only.
async function fetchAuditEvents(ids) {
  if (ids.length === 0) return [];
  const [rows] = await getPool().query(
    `SELECT al.id, al.occurred_at, al.event_type, al.entity_type, al.entity_id, al.details,
            p.sku AS product_sku, p.name AS product_name, c.name AS customer_name, ${ADMIN_COLUMNS}
       FROM audit_log al
       JOIN admins a ON a.id = al.admin_id
       LEFT JOIN products p ON al.entity_type = 'PRODUCT' AND p.id = al.entity_id
       LEFT JOIN customers c ON al.entity_type = 'CUSTOMER' AND c.id = al.entity_id
      WHERE al.id IN (?)`,
    [ids]
  );
  return rows;
}

module.exports = {
  listKeys,
  fetchOrderEvents,
  fetchOrderStockMovements,
  fetchStockEvents,
  fetchAuditEvents,
  buildUnion,
  escapeLike,
  sourcesFor,
};
