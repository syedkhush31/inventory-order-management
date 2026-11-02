// Shared set-up for the integration tests. Everything in tests/helpers/ that touches MySQL goes through this file.
//
// SAFETY, in layers (any failure throws before a single statement runs):
//   1. NODE_ENV must be "test", so config comes from server/.env.test and never from server/.env.
//   2. The configured DB_NAME must be exactly "inventory_test" (env.assertDbConfig + the explicit comparison below).
//   3. The server itself must report that the live connection is on "inventory_test" (SELECT DATABASE()).
//   4. query() only accepts SELECT, INSERT and UPDATE statements for fixtures and assertions. DELETE is never sent from
//      here: emptying the tables is done only by resetTestDatabase() in resetDb.js, which has its own guards.
//   5. Statements that change structure (DROP, ALTER, TRUNCATE, CREATE, GRANT, ...) are refused outright.
//
// A test file uses it like this:
//   const ctx = useIntegrationDatabase();   // registers the hooks; ctx.admin / ctx.cookie / ctx.api are filled per test
const crypto = require('crypto');
const env = require('../../src/config/env');
const { getPool, closePool } = require('../../src/config/db');
const authService = require('../../src/services/authService');
const { resetTestDatabase } = require('./resetDb');

// bcrypt (cost 12) and many requests per test need more than Jest's default 5 seconds.
const INTEGRATION_TIMEOUT = 30000;

let verified = false;

// Throws unless the configuration AND the live connection both point at inventory_test.
async function assertTestDatabase() {
  if (env.nodeEnv !== 'test') {
    throw new Error('Integration tests may only run with NODE_ENV=test.');
  }
  env.assertDbConfig(); // in test mode this already requires DB_NAME to be exactly inventory_test
  env.assertAuthConfig();
  if (env.db.name !== env.TEST_DATABASE_NAME) {
    throw new Error(`Refusing to run: configured DB_NAME is not exactly "${env.TEST_DATABASE_NAME}".`);
  }
  const [[row]] = await getPool().query('SELECT DATABASE() AS db'); // read-only
  if (row.db !== env.TEST_DATABASE_NAME) {
    throw new Error(`Refusing to run: connected database is not exactly "${env.TEST_DATABASE_NAME}".`);
  }
  verified = true;
}

const ALLOWED_STATEMENT = /^\s*(SELECT|INSERT|UPDATE)\b/i;
const FORBIDDEN_WORDS = /\b(DROP|ALTER|TRUNCATE|DELETE|CREATE|GRANT|REVOKE|RENAME)\b/i;
// A statement must not name a database. The connection already points at inventory_test, so every table is written
// unqualified. These rules refuse a dotted name such as inventory_dev.products (or a.b), any inventory_* name, and the
// MySQL system schemas. (Values travel as ? parameters, so they never appear in the statement text.)
const DOTTED_NAME = /[A-Za-z_`]\.[A-Za-z_`]/;
const OTHER_DATABASES = /\b(inventory_\w+|information_schema|mysql|performance_schema|sys)\b/i;

// Only fixture and assertion statements pass. Values always travel as ? parameters, never inside the text.
function assertFixtureStatement(sql) {
  if (typeof sql !== 'string' || !ALLOWED_STATEMENT.test(sql) || FORBIDDEN_WORDS.test(sql)) {
    throw new Error('Integration helpers may only run SELECT, INSERT and UPDATE statements.');
  }
  if (DOTTED_NAME.test(sql) || OTHER_DATABASES.test(sql)) {
    throw new Error('Integration helpers may not name a database: write table names without a schema prefix.');
  }
}

// Runs one fixture/assertion statement on the verified test database and returns the rows (SELECT) or the
// result header (INSERT / UPDATE, which has insertId and affectedRows).
async function query(sql, params = []) {
  assertFixtureStatement(sql);
  if (!verified) {
    await assertTestDatabase();
  }
  const [result] = await getPool().query(sql, params);
  return result;
}

async function closeDatabase() {
  verified = false;
  await closePool();
}

// Registers beforeAll / beforeEach / afterAll for the calling test file and returns a context object.
// Per test the context holds a fresh signed-in administrator:
//   ctx.app       the Express app
//   ctx.admin     { id, email }
//   ctx.cookie    "admin_token=<jwt>" for that administrator (minted directly, so no bcrypt per test)
//   ctx.api       supertest helpers that send that cookie: ctx.api.get / post / patch
//   ctx.passwordHash   a bcrypt hash of a random password, for creating further administrators
//   ctx.password       that random password (exists only in memory for this run)
function useIntegrationDatabase() {
  const ctx = { app: null, admin: null, cookie: null, api: null, password: null, passwordHash: null };

  beforeAll(async () => {
    // If a guard fails here nothing below runs, so nothing is written.
    await assertTestDatabase();
    await resetTestDatabase();
    ctx.password = crypto.randomBytes(16).toString('hex');
    ctx.passwordHash = await authService.hashPassword(ctx.password);
    ctx.app = require('../../src/app');
  }, INTEGRATION_TIMEOUT);

  beforeEach(async () => {
    await resetTestDatabase();
    // Required here (not at the top) because factories.js and http.js themselves use this file.
    const { createAdmin } = require('./factories');
    const { client, cookieFor } = require('./http');
    ctx.admin = await createAdmin({ passwordHash: ctx.passwordHash });
    ctx.cookie = cookieFor(ctx.admin);
    ctx.api = client(ctx.app, ctx.cookie);
  }, INTEGRATION_TIMEOUT);

  afterAll(async () => {
    try {
      await resetTestDatabase();
    } finally {
      await closeDatabase();
    }
  }, INTEGRATION_TIMEOUT);

  return ctx;
}

module.exports = {
  INTEGRATION_TIMEOUT,
  assertTestDatabase,
  assertFixtureStatement,
  query,
  closeDatabase,
  useIntegrationDatabase,
};
