// Checks that the app can reach MySQL and that the expected tables exist.
// Prints only a short status. It never prints credentials or the connection settings.
// "--env=test" switches to the test configuration for this one process only, so nothing
// needs to be set in the terminal (a leftover NODE_ENV would affect later commands).
if (process.argv.includes('--env=test')) {
  process.env.NODE_ENV = 'test';
}

const env = require('../src/config/env');
const { getPool, closePool } = require('../src/config/db');

const EXPECTED_TABLES = ['admins', 'products', 'customers', 'orders', 'order_items', 'order_status_history', 'stock_adjustments'];
const EXPECTED_STOCK_ADJUSTMENT_COLUMNS = ['order_id', 'movement_type'];

async function main() {
  env.assertDbConfig();
  const pool = getPool();
  const [[row]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`Connected to database: ${row.db}`);

  const [tables] = await pool.query(
    'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()'
  );
  const existing = new Set(tables.map((t) => t.name));
  const missing = EXPECTED_TABLES.filter((t) => !existing.has(t));
  if (missing.length > 0) {
    console.log(`Missing tables: ${missing.join(', ')} (has schema.sql been applied?)`);
    process.exitCode = 1;
  } else {
    console.log('All expected tables are present.');
  }

  // Migration 002 adds these columns to stock_adjustments. Order confirmation needs them.
  if (existing.has('stock_adjustments')) {
    const [columns] = await pool.query(
      `SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'stock_adjustments'`
    );
    const have = new Set(columns.map((c) => c.name));
    const missingColumns = EXPECTED_STOCK_ADJUSTMENT_COLUMNS.filter((c) => !have.has(c));
    if (missingColumns.length > 0) {
      console.log(`stock_adjustments is missing columns: ${missingColumns.join(', ')} (apply migration 002)`);
      process.exitCode = 1;
    } else {
      console.log('stock_adjustments has the order columns.');
    }
  }
}

main()
  .catch((err) => {
    // err.code is a short category such as ER_ACCESS_DENIED_ERROR; the message may contain host/user.
    console.error(`Database check failed: ${err.code || String(err.message).split('\n')[0]}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
