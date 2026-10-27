// Checks the cleanup helper's safety guards with a fake pool: MySQL is never contacted.
// The fake records every statement so we can prove no DELETE is issued when a guard fails.
const crypto = require('crypto');

process.env.DB_HOST = 'localhost';
process.env.DB_USER = 'fake_user';
process.env.DB_PASSWORD = crypto.randomBytes(8).toString('hex');
process.env.DB_NAME = 'inventory_test';

const env = require('../../src/config/env');
const { resetTestDatabase, assertLiveDatabaseIsTestDatabase, TABLES_IN_DELETE_ORDER } = require('../helpers/resetDb');

function fakePool(liveDatabase) {
  const statements = [];
  return {
    statements,
    query: async (sql) => {
      statements.push(sql);
      return sql.startsWith('SELECT DATABASE()') ? [[{ db: liveDatabase }]] : [{}];
    },
  };
}

const deletes = (pool) => pool.statements.filter((s) => /^(DELETE|INSERT|UPDATE|TRUNCATE|DROP)/i.test(s));

describe('assertLiveDatabaseIsTestDatabase', () => {
  test('accepts only exactly inventory_test', () => {
    expect(() => assertLiveDatabaseIsTestDatabase('inventory_test')).not.toThrow();
    for (const name of ['inventory_dev', 'othershop_test', 'inventory_test2', 'INVENTORY_TEST', '', null, undefined]) {
      expect(() => assertLiveDatabaseIsTestDatabase(name)).toThrow(/exactly/);
    }
  });
});

describe('resetTestDatabase', () => {
  const originalName = env.db.name;
  const originalMode = env.nodeEnv;
  afterEach(() => {
    env.db.name = originalName;
    env.nodeEnv = originalMode;
    process.env.DB_NAME = 'inventory_test';
  });

  test('rejects when the loaded config name differs even if the raw variable looks right', async () => {
    env.db.name = 'othershop_test';
    const pool = fakePool('inventory_test');
    await expect(resetTestDatabase(pool)).rejects.toThrow(/configured DB_NAME/);
    expect(pool.statements).toEqual([]);
  });

  test('under Jest the environment is test mode with the exact test database configured', () => {
    expect(env.nodeEnv).toBe('test');
    expect(env.db.name).toBe('inventory_test');
  });

  test.each(['inventory_dev', 'othershop_test'])('rejects a live database named %s without any write', async (live) => {
    const pool = fakePool(live);
    await expect(resetTestDatabase(pool)).rejects.toThrow(/Refusing to reset/);
    expect(pool.statements).toEqual(['SELECT DATABASE() AS db']); // read-only, no DELETE
  });

  test('rejects when no database is selected', async () => {
    const pool = fakePool(null);
    await expect(resetTestDatabase(pool)).rejects.toThrow(/Refusing to reset/);
    expect(deletes(pool)).toEqual([]);
  });

  test.each(['inventory_dev', 'othershop_test'])('rejects configured DB_NAME %s before touching the pool', async (name) => {
    env.db.name = name;
    process.env.DB_NAME = name;
    const pool = fakePool('inventory_test');
    await expect(resetTestDatabase(pool)).rejects.toThrow();
    expect(pool.statements).toEqual([]); // not even the SELECT
  });

  test('refuses outside test mode before touching the pool', async () => {
    env.nodeEnv = 'development';
    const pool = fakePool('inventory_test');
    await expect(resetTestDatabase(pool)).rejects.toThrow(/NODE_ENV=test/);
    expect(pool.statements).toEqual([]);
  });

  test('with the exact database it deletes the six tables, children before parents', async () => {
    const pool = fakePool('inventory_test');
    await resetTestDatabase(pool);
    expect(pool.statements).toEqual([
      'SELECT DATABASE() AS db',
      'DELETE FROM `order_status_history`',
      'DELETE FROM `order_items`',
      'DELETE FROM `orders`',
      'DELETE FROM `customers`',
      'DELETE FROM `products`',
      'DELETE FROM `admins`',
    ]);
    expect(TABLES_IN_DELETE_ORDER).toHaveLength(6);
  });
});
