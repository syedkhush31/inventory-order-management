// All SQL for the admins table. Uses prepared statements (execute) with ? placeholders only.
const { getPool } = require('../config/db');

async function findByEmail(email) {
  const [rows] = await getPool().execute(
    'SELECT id, email, password_hash, is_active FROM admins WHERE email = ? LIMIT 1',
    [email]
  );
  return rows[0] || null;
}

async function findById(id) {
  const [rows] = await getPool().execute(
    'SELECT id, email, is_active FROM admins WHERE id = ? LIMIT 1',
    [id]
  );
  return rows[0] || null;
}

async function countAll() {
  const [rows] = await getPool().execute('SELECT COUNT(*) AS total FROM admins');
  return Number(rows[0].total);
}

async function create({ email, passwordHash }) {
  const [result] = await getPool().execute(
    'INSERT INTO admins (email, password_hash) VALUES (?, ?)',
    [email, passwordHash]
  );
  return result.insertId;
}

module.exports = { findByEmail, findById, countAll, create };
