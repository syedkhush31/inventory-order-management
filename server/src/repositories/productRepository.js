// All SQL for the products table.
//
// Query strategy: pool.query() with ? placeholders. mysql2 fills the placeholders on the client
// (escaping strings, writing integers as plain digits), so LIMIT/OFFSET work on every MySQL 8 version.
// (pool.execute() sends numbers as DOUBLE, which newer MySQL 8 servers can reject for LIMIT.)
// Sort columns cannot be placeholders, so they come from the fixed whitelist below.
const { getPool } = require('../config/db');

const SORT_COLUMNS = {
  sku: 'sku',
  name: 'name',
  price: 'price',
  stockQuantity: 'stock_quantity',
  updatedAt: 'updated_at',
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
function buildWhere({ q, status }) {
  const conditions = [];
  const values = [];

  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    conditions.push("(sku LIKE ? ESCAPE '!' OR name LIKE ? ESCAPE '!')");
    values.push(pattern, pattern);
  }
  if (status === 'active') {
    conditions.push('is_active = 1');
  } else if (status === 'inactive') {
    conditions.push('is_active = 0');
  }

  return { sql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', values };
}

// Returns { rows, total } for one page of products.
async function list({ q, status, sort, order, page, pageSize }) {
  const sortColumn = SORT_COLUMNS[sort];
  if (!sortColumn) {
    throw new Error('Unsupported sort key');
  }
  const direction = order === 'desc' ? 'DESC' : 'ASC';
  const offset = (page - 1) * pageSize;
  assertSafeInteger(pageSize, 'pageSize');
  assertSafeInteger(offset, 'offset');

  const where = buildWhere({ q, status });
  const pool = getPool();

  const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM products ${where.sql}`, where.values);

  // "id ASC" breaks ties so rows never jump between pages.
  const [rows] = await pool.query(
    `SELECT id, sku, name, price, stock_quantity, is_active, created_at, updated_at
       FROM products ${where.sql}
       ORDER BY ${sortColumn} ${direction}, id ASC
       LIMIT ? OFFSET ?`,
    [...where.values, pageSize, offset]
  );

  return { rows, total: Number(countRows[0].total) };
}

// Inserts one product and returns its new id. is_active, created_at and updated_at use the
// table defaults, so a new product is always active. A duplicate SKU makes MySQL throw
// ER_DUP_ENTRY (the unique key uq_products_sku is the final authority, even for concurrent requests).
async function create({ sku, name, price, stockQuantity }) {
  const [result] = await getPool().query(
    'INSERT INTO products (sku, name, price, stock_quantity) VALUES (?, ?, ?, ?)',
    [sku, name, price, stockQuantity]
  );
  return result.insertId;
}

async function findById(id) {
  const [rows] = await getPool().query(
    'SELECT id, sku, name, price, stock_quantity, is_active, created_at, updated_at FROM products WHERE id = ? LIMIT 1',
    [id]
  );
  return rows[0] || null;
}

// The columns an edit may change. Column names cannot be placeholders, so they come from this fixed list;
// the values always go through ? placeholders.
const EDITABLE_COLUMNS = { sku: 'sku', name: 'name', price: 'price' };

// Changes only the fields that were sent. Does nothing if no editable field is present. A duplicate SKU makes
// MySQL throw ER_DUP_ENTRY (uq_products_sku). A product id that does not exist simply matches no row.
async function update(id, fields) {
  const keys = Object.keys(EDITABLE_COLUMNS).filter((key) => fields[key] !== undefined);
  if (keys.length === 0) {
    return;
  }
  const assignments = keys.map((key) => `${EDITABLE_COLUMNS[key]} = ?`).join(', ');
  await getPool().query(`UPDATE products SET ${assignments} WHERE id = ?`, [...keys.map((key) => fields[key]), id]);
}

// Sets the soft-delete flag. Setting the value it already has is harmless (and leaves updated_at alone).
async function setActive(id, isActive) {
  await getPool().query('UPDATE products SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, id]);
}

// ---- Used inside a transaction: `connection` comes from withTransaction() in config/db.js ----

// Reads the stock and locks the row until the transaction ends, so two simultaneous corrections to the same
// product run one after the other. Returns { id, stock_quantity } or null if the product does not exist.
async function lockForUpdate(connection, id) {
  const [rows] = await connection.query('SELECT id, stock_quantity FROM products WHERE id = ? LIMIT 1 FOR UPDATE', [id]);
  return rows[0] || null;
}

// Writes an absolute quantity (already checked by the caller). The column is UNSIGNED, so MySQL itself would
// still refuse a negative value.
async function setStockQuantity(connection, id, stockQuantity) {
  await connection.query('UPDATE products SET stock_quantity = ? WHERE id = ?', [stockQuantity, id]);
}

module.exports = {
  list,
  create,
  findById,
  update,
  setActive,
  lockForUpdate,
  setStockQuantity,
  SORT_COLUMNS,
  EDITABLE_COLUMNS,
  escapeLike,
};
