// Proves the safety net in tests/setup/blockRealDatabase.js: inside a unit test the MySQL driver can not open a pool,
// so no unit test can reach a real database (inventory_dev or inventory_test) by accident.
const mysql = require('mysql2/promise');

test('creating a connection pool inside a unit test is refused', () => {
  expect(() => mysql.createPool({ host: 'localhost', user: 'x', password: 'x', database: 'x' })).toThrow(
    /must not open a database connection/
  );
});

test('the real transaction helper can not run in a unit test unless config/db is mocked', async () => {
  const { withTransaction } = require('../../src/config/db');
  const fn = jest.fn(async () => 1);
  // Either the environment check refuses first or the guarded driver refuses; either way no connection is made
  // and the callback never runs.
  await expect(withTransaction(fn)).rejects.toThrow(/must not open a database connection|environment variable|Refusing to run/);
  expect(fn).not.toHaveBeenCalled();
});
