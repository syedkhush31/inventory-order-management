// All SQL for the stock_adjustments table (the history of manual stock corrections).
// insert() takes the `connection` of a transaction, so the history row is saved or discarded
// together with the stock change it describes. listByProduct() only reads, using the pool.
const { getPool } = require('../config/db');

// Inserts one history row and returns it as stored (including the timestamp MySQL generated).
async function insert(connection, { productId, quantityDelta, reason, adminId }) {
  const [result] = await connection.query(
    'INSERT INTO stock_adjustments (product_id, quantity_delta, reason, admin_id) VALUES (?, ?, ?, ?)',
    [productId, quantityDelta, reason, adminId]
  );
  const [rows] = await connection.query(
    'SELECT id, product_id, quantity_delta, reason, admin_id, created_at FROM stock_adjustments WHERE id = ? LIMIT 1',
    [result.insertId]
  );
  return rows[0];
}

// Inserts the stock movement caused by an order: movementType is 'ORDER_CONFIRMED' (a deduction, negative delta) or
// 'ORDER_CANCELLED' (a restore, positive delta). Needs migration 002. The unique key (order_id, product_id,
// movement_type) makes MySQL refuse a second deduction or restore for the same order and product.
async function insertOrderMovement(connection, { productId, quantityDelta, reason, adminId, orderId, movementType }) {
  await connection.query(
    `INSERT INTO stock_adjustments (product_id, quantity_delta, reason, admin_id, order_id, movement_type)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [productId, quantityDelta, reason, adminId, orderId, movementType]
  );
}

// One page of a product's history, newest first ("id DESC" breaks ties so rows never jump between pages).
// Returns { rows, total }. pool.query() with ? placeholders, as in productRepository.
async function listByProduct(productId, { page, pageSize }) {
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('pageSize and offset must be non-negative integers');
  }
  const pool = getPool();

  const [countRows] = await pool.query('SELECT COUNT(*) AS total FROM stock_adjustments WHERE product_id = ?', [
    productId,
  ]);
  const [rows] = await pool.query(
    `SELECT id, product_id, quantity_delta, reason, admin_id, created_at
       FROM stock_adjustments
      WHERE product_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`,
    [productId, pageSize, offset]
  );
  return { rows, total: Number(countRows[0].total) };
}

module.exports = { insert, insertOrderMovement, listByProduct };
