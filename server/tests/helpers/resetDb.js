// Empties every table in the TEST database between tests.
// Uses DELETE (not TRUNCATE) because the app account has no DROP privilege.
// Every guard runs before the first DELETE; any failure throws and nothing is deleted.
const env = require('../../src/config/env');
const { getPool } = require('../../src/config/db');

// Children first, so foreign keys are never violated.
const TABLES_IN_DELETE_ORDER = ['stock_adjustments', 'order_status_history', 'order_items', 'orders', 'customers', 'products', 'admins'];

// The database the server reports for this connection must be exactly the test database.
function assertLiveDatabaseIsTestDatabase(liveName) {
  if (liveName !== env.TEST_DATABASE_NAME) {
    throw new Error(`Refusing to reset: connected database is not exactly "${env.TEST_DATABASE_NAME}".`);
  }
}

// `pool` can be replaced in unit tests so no real database is needed.
async function resetTestDatabase(pool) {
  if (env.nodeEnv !== 'test') {
    throw new Error('resetTestDatabase may only run when NODE_ENV=test.');
  }
  env.assertDbConfig(); // in test mode this requires DB_NAME to be exactly inventory_test
  if (env.db.name !== env.TEST_DATABASE_NAME) {
    throw new Error(`Refusing to reset: configured DB_NAME is not exactly "${env.TEST_DATABASE_NAME}".`);
  }

  const activePool = pool || getPool();
  // Ask the server itself which database this connection is really using.
  const [[row]] = await activePool.query('SELECT DATABASE() AS db');
  assertLiveDatabaseIsTestDatabase(row.db);

  for (const table of TABLES_IN_DELETE_ORDER) {
    await activePool.query(`DELETE FROM \`${table}\``); // table names come from the constant above
  }
}

module.exports = { resetTestDatabase, assertLiveDatabaseIsTestDatabase, TABLES_IN_DELETE_ORDER };
