// All SQL for the admins table. Uses prepared statements (execute) with ? placeholders only, except the functions that
// take a transaction `connection` (see withTransaction in config/db.js), which use connection.query with ? placeholders.
const { getPool } = require('../config/db');

// password_hash is read only where it is needed to check a password. It is never part of a response.
async function findByEmail(email) {
  const [rows] = await getPool().execute(
    'SELECT id, email, password_hash, is_active, token_version FROM admins WHERE email = ? LIMIT 1',
    [email]
  );
  return rows[0] || null;
}

async function findById(id) {
  const [rows] = await getPool().execute(
    'SELECT id, email, is_active, token_version FROM admins WHERE id = ? LIMIT 1',
    [id]
  );
  return rows[0] || null;
}

// The profile shown on the Settings page. No password hash and no session version.
async function findProfile(id) {
  const [rows] = await getPool().execute(
    'SELECT id, email, display_name, created_at FROM admins WHERE id = ? LIMIT 1',
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

// ---- Used inside a transaction: `connection` comes from withTransaction() ----

// Reads the whole account and locks the row until the transaction ends, so a profile edit or a password change sees
// (and changes) the real current values, and two changes at once run one after the other.
async function findForUpdate(connection, id) {
  const [rows] = await connection.query(
    `SELECT id, email, display_name, password_hash, is_active, token_version, created_at
       FROM admins WHERE id = ? LIMIT 1 FOR UPDATE`,
    [id]
  );
  return rows[0] || null;
}

// The columns a profile edit may change. Column names cannot be placeholders, so they come from this fixed list;
// the values always go through ? placeholders. A duplicate email makes MySQL throw ER_DUP_ENTRY (uq_admins_email).
const PROFILE_COLUMNS = { displayName: 'display_name', email: 'email' };

async function updateProfile(connection, id, fields) {
  const keys = Object.keys(PROFILE_COLUMNS).filter((key) => fields[key] !== undefined);
  if (keys.length === 0) {
    return;
  }
  const assignments = keys.map((key) => `${PROFILE_COLUMNS[key]} = ?`).join(', ');
  await connection.query(`UPDATE admins SET ${assignments} WHERE id = ?`, [...keys.map((key) => fields[key]), id]);
}

// Saves the new password hash AND raises the session version in ONE statement, so the two can never be out of step:
// every login token issued before this moment stops working the instant this commits.
async function updatePasswordAndBumpVersion(connection, id, passwordHash) {
  await connection.query('UPDATE admins SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [
    passwordHash,
    id,
  ]);
}

module.exports = {
  findByEmail,
  findById,
  findProfile,
  countAll,
  create,
  findForUpdate,
  updateProfile,
  updatePasswordAndBumpVersion,
  PROFILE_COLUMNS,
};
