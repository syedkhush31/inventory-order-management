// A brand-new copy of the Express app, with brand-new rate-limiter counters.
//
// The login limiter and the password-attempt limiter keep their counts in memory inside the app module, and a test file
// shares one app. A test that deliberately exhausts a limiter must therefore use its own copy, so that it cannot affect
// the other tests (or be affected by them). jest.isolateModules loads the whole app again in a separate module registry;
// that copy has its own database pool, which the caller must close with close().
//
// SAFETY: the copy reads the same configuration (server/.env.test, NODE_ENV=test), and before returning it checks, with
// a read-only query, that its own pool is connected to exactly inventory_test.
//
//   const fresh = await freshApp();
//   try { ... client(fresh.app, cookie) ... } finally { await fresh.close(); }
const env = require('../../src/config/env');

async function freshApp() {
  if (env.nodeEnv !== 'test') {
    throw new Error('freshApp may only be used with NODE_ENV=test.');
  }
  let app;
  let isolatedDb;
  jest.isolateModules(() => {
    isolatedDb = require('../../src/config/db');
    app = require('../../src/app');
  });

  try {
    const [[row]] = await isolatedDb.getPool().query('SELECT DATABASE() AS db'); // read-only
    if (row.db !== env.TEST_DATABASE_NAME) {
      throw new Error(`Refusing to continue: the isolated app is connected to a database that is not exactly "${env.TEST_DATABASE_NAME}".`);
    }
  } catch (err) {
    await isolatedDb.closePool();
    throw err;
  }
  return { app, close: () => isolatedDb.closePool() };
}

module.exports = { freshApp };
