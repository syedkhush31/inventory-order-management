// Gives rows exact timestamps, so ordering, paging and date-range tests do not depend on real time passing.
// MySQL TIMESTAMP columns here have one-second resolution: rows created in the same second would otherwise tie.
//
// Only UPDATEs, only on the verified test database, only on the columns listed below. The session time zone of the
// app's connections is UTC, so a JavaScript Date is stored as exactly that instant.
const { query } = require('./integrationEnv');

// The time columns each table can be back-dated on. For orders both are set together, because updated_at is
// refreshed automatically whenever the row changes.
const TIME_COLUMNS = {
  orders: ['created_at', 'updated_at'],
  stock_adjustments: ['created_at'],
  order_status_history: ['changed_at'],
  audit_log: ['occurred_at'],
};

async function backdate(table, id, date) {
  const columns = TIME_COLUMNS[table];
  if (!columns) {
    throw new Error(`backdate does not support the table: ${table}`);
  }
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('backdate needs a valid Date.');
  }
  const assignments = columns.map((column) => `${column} = ?`).join(', '); // column names come from the list above
  await query(`UPDATE ${table} SET ${assignments} WHERE id = ?`, [...columns.map(() => date), id]);
}

// A fixed starting point for building timelines, and a helper for "n minutes after it".
const BASE_TIME = new Date('2026-10-01T09:00:00.000Z');
const minutesAfter = (minutes, base = BASE_TIME) => new Date(base.getTime() + minutes * 60 * 1000);

module.exports = { backdate, BASE_TIME, minutesAfter };
