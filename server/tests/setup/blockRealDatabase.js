// Safety net for every UNIT test file: a unit test must never open a real database connection.
// Without it, a test that forgets to mock config/db would connect with the settings of server/.env.test, which names
// inventory_test. Here the MySQL driver is replaced by a fake whose createPool() refuses, so such a test fails at once
// with a clear message instead of reaching a database. A test file that mocks 'mysql2/promise' itself (db.test.js)
// keeps its own mock, and the integration tests (tests/integration) are left alone because they need the real driver.
const testPath = expect.getState().testPath || '';

if (!/[\\/]tests[\\/]integration[\\/]/.test(testPath)) {
  jest.mock('mysql2/promise', () => ({
    createPool: () => {
      throw new Error('Unit tests must not open a database connection. Mock src/config/db in this test.');
    },
  }));
}
