// All SQL for the customers table. Customers are never deleted: "deactivate" only clears is_active, because
// orders keep pointing at the customer (orders.customer_id has ON DELETE RESTRICT).
//
// Query strategy is the same as productRepository: pool.query() with ? placeholders, and sort / column names
// taken only from the fixed whitelists below.
const { getPool } = require('../config/db');

const SORT_COLUMNS = {
  name: 'name',
  email: 'email',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const COLUMNS = 'id, name, email, phone, address, is_active, created_at, updated_at';

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
    conditions.push("(name LIKE ? ESCAPE '!' OR email LIKE ? ESCAPE '!' OR phone LIKE ? ESCAPE '!')");
    values.push(pattern, pattern, pattern);
  }
  if (status === 'active') {
    conditions.push('is_active = 1');
  } else if (status === 'inactive') {
    conditions.push('is_active = 0');
  }

  return { sql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', values };
}

// Returns { rows, total } for one page of customers.
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

  const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM customers ${where.sql}`, where.values);

  // "id ASC" breaks ties so rows never jump between pages.
  const [rows] = await pool.query(
    `SELECT ${COLUMNS}
       FROM customers ${where.sql}
       ORDER BY ${sortColumn} ${direction}, id ASC
       LIMIT ? OFFSET ?`,
    [...where.values, pageSize, offset]
  );

  return { rows, total: Number(countRows[0].total) };
}

// Inserts one customer and returns its new id. New customers are active (the table default). A duplicate email
// makes MySQL throw ER_DUP_ENTRY (the unique key uq_customers_email is the final authority, even for concurrent requests).
async function create({ name, email, phone, address }) {
  const [result] = await getPool().query('INSERT INTO customers (name, email, phone, address) VALUES (?, ?, ?, ?)', [
    name,
    email,
    phone,
    address,
  ]);
  return result.insertId;
}

async function findById(id) {
  const [rows] = await getPool().query(`SELECT ${COLUMNS} FROM customers WHERE id = ? LIMIT 1`, [id]);
  return rows[0] || null;
}

// The columns an edit may change. Column names cannot be placeholders, so they come from this fixed list;
// the values always go through ? placeholders.
const EDITABLE_COLUMNS = { name: 'name', email: 'email', phone: 'phone', address: 'address' };

// Changes only the fields that were sent (null is a real value: it clears phone or address). Does nothing if no
// editable field is present. A duplicate email makes MySQL throw ER_DUP_ENTRY. An id that does not exist matches no row.
async function update(id, fields) {
  const keys = Object.keys(EDITABLE_COLUMNS).filter((key) => fields[key] !== undefined);
  if (keys.length === 0) {
    return;
  }
  const assignments = keys.map((key) => `${EDITABLE_COLUMNS[key]} = ?`).join(', ');
  await getPool().query(`UPDATE customers SET ${assignments} WHERE id = ?`, [...keys.map((key) => fields[key]), id]);
}

// Sets the soft-delete flag. Setting the value it already has is harmless (and leaves updated_at alone).
async function setActive(id, isActive) {
  await getPool().query('UPDATE customers SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, id]);
}

module.exports = { list, create, findById, update, setActive, SORT_COLUMNS, EDITABLE_COLUMNS, escapeLike };
