// No database access. Checks the startup validation rules with made-up values.
const { assertDbConfig, assertAuthConfig } = require('../../src/config/env');

describe('assertDbConfig', () => {
  const base = { DB_HOST: 'h', DB_USER: 'u', DB_PASSWORD: 'p' };

  test('names every missing variable without printing values', () => {
    expect(() => assertDbConfig({}, 'development')).toThrow(/DB_HOST, DB_NAME, DB_USER, DB_PASSWORD/);
  });

  test('treats an empty password as missing', () => {
    expect(() => assertDbConfig({ ...base, DB_NAME: 'inventory_dev', DB_PASSWORD: '' }, 'development')).toThrow(
      /DB_PASSWORD/
    );
  });

  test('test mode accepts exactly inventory_test and nothing else', () => {
    expect(() => assertDbConfig({ ...base, DB_NAME: 'inventory_test' }, 'test')).not.toThrow();
    for (const name of ['inventory_dev', 'othershop_test', 'inventory_test2', 'Inventory_Test', 'my_inventory_test', ' inventory_test']) {
      expect(() => assertDbConfig({ ...base, DB_NAME: name }, 'test')).toThrow(/exactly "inventory_test"/);
    }
  });

  test('development mode rejects a _test database', () => {
    expect(() => assertDbConfig({ ...base, DB_NAME: 'inventory_test' }, 'development')).toThrow(/_test/);
    expect(() => assertDbConfig({ ...base, DB_NAME: 'inventory_dev' }, 'development')).not.toThrow();
  });
});

describe('assertAuthConfig', () => {
  test('rejects missing, short and placeholder secrets', () => {
    expect(() => assertAuthConfig({})).toThrow(/JWT_SECRET/);
    expect(() => assertAuthConfig({ JWT_SECRET: 'short' })).toThrow(/at least 32/);
    expect(() => assertAuthConfig({ JWT_SECRET: 'replace_with_a_long_random_string_value_here' })).toThrow(
      /at least 32/
    );
  });

  test('accepts a long secret and never echoes it in errors', () => {
    expect(() => assertAuthConfig({ JWT_SECRET: 'x'.repeat(40) })).not.toThrow();
    try {
      assertAuthConfig({ JWT_SECRET: 'tiny-secret-value' });
    } catch (err) {
      expect(err.message).not.toContain('tiny-secret-value');
    }
  });
});
