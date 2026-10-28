// All SQL for orders, order_items and order_status_history. Orders are never deleted.
//
// Reads use pool.query() with ? placeholders, and sort / column names come only from the whitelist below.
// The write helpers take the `connection` of a transaction, so the order, its items and its first history
// row are saved or discarded together. They never open a transaction themselves.
const { getPool } = require('../config/db');

const SORT_COLUMNS = {
  id: 'o.id',
  createdAt: 'o.created_at',
  updatedAt: 'o.updated_at',
  totalAmount: 'o.total_amount',
  status: 'o.status',
  customerName: 'c.name',
};

// "!" is used as the LIKE escape character so no backslashes are involved.
function escapeLike(text) {
  return text.replace(/[!%_]/g, (char) => `!${char}`);
}

function assertSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

// Builds the shared WHERE clause. Only fixed SQL text goes in `sql`; user input goes in `values`.
// A search such as "12" or "#12" also matches the order with that id; any search matches the customer name or email.
function buildWhere({ q, status }) {
  const conditions = [];
  const values = [];

  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    const searchParts = ["c.name LIKE ? ESCAPE '!'", "c.email LIKE ? ESCAPE '!'"];
    values.push(pattern, pattern);
    const idMatch = /^#?([1-9]\d{0,14})$/.exec(q);
    if (idMatch) {
      searchParts.push('o.id = ?');
      values.push(Number(idMatch[1]));
    }
    conditions.push(`(${searchParts.join(' OR ')})`);
  }
  if (status && status !== 'all') {
    conditions.push('o.status = ?');
    values.push(status);
  }

  return { sql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', values };
}

const ORDER_COLUMNS = `o.id, o.customer_id, c.name AS customer_name, c.email AS customer_email,
       c.is_active AS customer_is_active, o.status, o.total_amount, o.created_at, o.updated_at`;

// Returns { rows, total } for one page of orders, each with its customer and item count.
async function list({ q, status, sort, order, page, pageSize }) {
  const sortColumn = SORT_COLUMNS[sort];
  if (!sortColumn) {
    throw new Error('Unsupported sort key');
  }
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const offset = (page - 1) * pageSize;
  assertSafeInteger(pageSize, 'pageSize');
  assertSafeInteger(offset, 'offset');

  const where = buildWhere({ q, status });
  const pool = getPool();

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM orders o JOIN customers c ON c.id = o.customer_id ${where.sql}`,
    where.values
  );

  // "o.id" breaks ties so rows never jump between pages.
  const [rows] = await pool.query(
    `SELECT ${ORDER_COLUMNS},
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
       FROM orders o JOIN customers c ON c.id = o.customer_id ${where.sql}
       ORDER BY ${sortColumn} ${direction}, o.id ${direction}
       LIMIT ? OFFSET ?`,
    [...where.values, pageSize, offset]
  );

  return { rows, total: Number(countRows[0].total) };
}

async function findById(id) {
  const [rows] = await getPool().query(
    `SELECT ${ORDER_COLUMNS} FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

// The order's lines with the price saved when it was placed (order_items.unit_price), never today's product price.
async function listItems(orderId) {
  const [rows] = await getPool().query(
    `SELECT oi.id, oi.product_id, p.sku, p.name AS product_name, oi.quantity, oi.unit_price
       FROM order_items oi JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?
      ORDER BY oi.id ASC`,
    [orderId]
  );
  return rows;
}

// Oldest first, so the list reads as a timeline.
async function listStatusHistory(orderId) {
  const [rows] = await getPool().query(
    `SELECT id, order_id, from_status, to_status, changed_by_admin_id, changed_at
       FROM order_status_history
      WHERE order_id = ?
      ORDER BY changed_at ASC, id ASC`,
    [orderId]
  );
  return rows;
}

// ---- Inside a transaction (all take the transaction's connection) ----

// Reads the customer and takes a shared lock, so it cannot be deactivated or changed until this transaction ends.
async function findCustomerForOrder(connection, customerId) {
  const [rows] = await connection.query(
    'SELECT id, is_active FROM customers WHERE id = ? LIMIT 1 FOR SHARE',
    [customerId]
  );
  return rows[0] || null;
}

// Reads the products and takes shared locks, so a price edit has to wait and the price we copy is the one committed.
// Sorted by id so concurrent transactions always lock in the same order. Unknown ids are simply missing from the result.
async function findProductsForOrder(connection, productIds) {
  const [rows] = await connection.query(
    'SELECT id, price, is_active FROM products WHERE id IN (?) ORDER BY id ASC FOR SHARE',
    [productIds]
  );
  return rows;
}

// New orders are always PENDING (the table default). Returns the new order id.
async function insertOrder(connection, { customerId, totalAmount }) {
  const [result] = await connection.query('INSERT INTO orders (customer_id, total_amount) VALUES (?, ?)', [
    customerId,
    totalAmount,
  ]);
  return result.insertId;
}

// items: [{ productId, quantity, unitPrice }] in one multi-row INSERT.
async function insertItems(connection, orderId, items) {
  const values = items.map((item) => [orderId, item.productId, item.quantity, item.unitPrice]);
  await connection.query('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ?', [values]);
}

// fromStatus is null for the first record of an order.
async function insertStatusHistory(connection, { orderId, fromStatus, toStatus, adminId }) {
  await connection.query(
    'INSERT INTO order_status_history (order_id, from_status, to_status, changed_by_admin_id) VALUES (?, ?, ?, ?)',
    [orderId, fromStatus, toStatus, adminId]
  );
}

// Locks the order row until the transaction ends, so two simultaneous status changes (for example two clicks on
// Confirm) run one after the other, and the second one sees the status the first one set.
// Returns { id, status } or null if the order does not exist.
async function lockOrder(connection, orderId) {
  const [rows] = await connection.query('SELECT id, status FROM orders WHERE id = ? LIMIT 1 FOR UPDATE', [orderId]);
  return rows[0] || null;
}

// The order's lines as { product_id, quantity }, lowest product id first. Lines are never edited after creation.
async function listItemQuantities(connection, orderId) {
  const [rows] = await connection.query(
    'SELECT product_id, quantity FROM order_items WHERE order_id = ? ORDER BY product_id ASC',
    [orderId]
  );
  return rows;
}

async function updateStatus(connection, orderId, status) {
  await connection.query('UPDATE orders SET status = ? WHERE id = ?', [status, orderId]);
}

module.exports = {
  list,
  findById,
  listItems,
  listStatusHistory,
  findCustomerForOrder,
  findProductsForOrder,
  insertOrder,
  insertItems,
  insertStatusHistory,
  lockOrder,
  listItemQuantities,
  updateStatus,
  SORT_COLUMNS,
  escapeLike,
};
