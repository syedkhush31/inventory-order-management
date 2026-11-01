// All SQL for the app_settings table: one row per setting (setting_key, setting_value). A setting with no row uses its
// built-in default in settingsService. Every statement uses ? placeholders only.
//
// The writing functions take the `connection` of a transaction (see withTransaction in config/db.js), so a setting
// change and its audit record are saved or discarded together. Reading uses the pool unless a connection is given.
//
// Both writes are INSERT ... ON DUPLICATE KEY UPDATE on the primary key (setting_key), so "create the row if it is
// missing, otherwise change it" is ONE atomic statement. There is never a separate "does it exist?" check followed by an
// INSERT or UPDATE, which is what let two first-time saves collide. The new values are passed as parameters twice instead
// of using VALUES(), which newer MySQL 8 versions mark as deprecated.
const { getPool } = require('../config/db');

// Returns the stored text for a setting, or null when there is no row. A plain read: it takes no locks.
async function getValue(key, executor = getPool()) {
  const [rows] = await executor.query('SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1', [key]);
  return rows.length > 0 ? String(rows[0].setting_value) : null;
}

// Makes sure the row exists WITHOUT changing the effective value: if it is missing it is created holding the default
// (which is what "no row" already means), and if it exists nothing changes. Either way this transaction now holds the
// row's lock, so the read and the write that follow see and change the real current value. One atomic statement.
async function ensureRow(connection, { key, defaultValue }) {
  await connection.query(
    `INSERT INTO app_settings (setting_key, setting_value, updated_by_admin_id) VALUES (?, ?, NULL)
     ON DUPLICATE KEY UPDATE setting_value = setting_value`,
    [key, defaultValue]
  );
}

// Reads the stored value and locks the row until the transaction ends. Call ensureRow first, so the row exists and the
// lock is a lock on that row (not on the gap where a missing row would be).
async function getValueForUpdate(connection, key) {
  const [rows] = await connection.query(
    'SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1 FOR UPDATE',
    [key]
  );
  return rows.length > 0 ? String(rows[0].setting_value) : null;
}

// Saves the value and records who saved it: inserts the row if it is missing, otherwise changes it. One atomic statement.
async function upsert(connection, { key, value, adminId }) {
  await connection.query(
    `INSERT INTO app_settings (setting_key, setting_value, updated_by_admin_id) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = ?, updated_by_admin_id = ?`,
    [key, value, adminId, value, adminId]
  );
}

module.exports = { getValue, ensureRow, getValueForUpdate, upsert };
