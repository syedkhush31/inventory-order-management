// No database access. Checks the startup validation rules with made-up values.
const fs = require('fs');
const path = require('path');
const env = require('../../src/config/env');

const { assertDbConfig, assertAuthConfig, assertServerMode } = env;

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

describe('assertServerMode (starting the API)', () => {
  test.each(['development', 'production'])('allows %s', (mode) => {
    expect(() => assertServerMode(mode)).not.toThrow();
  });

  test('refuses test mode with a message that says how to fix it', () => {
    expect(() => assertServerMode('test')).toThrow(/Refusing to start the API with NODE_ENV=test/);
    expect(() => assertServerMode('test')).toThrow(/Remove-Item Env:NODE_ENV/);
  });

  test.each([undefined, null, '', '   ', 42, {}])('refuses a missing or empty mode: %p', (mode) => {
    expect(() => assertServerMode(mode)).toThrow(/empty or missing/);
  });

  test.each(['staging', 'Development', 'PRODUCTION', 'dev', 'prod', 'tests', ' development', 'production '])(
    'refuses the unsupported mode %j',
    (mode) => {
      expect(() => assertServerMode(mode)).toThrow(/Unsupported NODE_ENV/);
    }
  );

  test('a very long unsupported value is shortened in the message', () => {
    const message = (() => {
      try {
        assertServerMode('x'.repeat(500));
      } catch (err) {
        return err.message;
      }
      return '';
    })();
    expect(message.length).toBeLessThan(200);
  });

  test('under Jest the resolved mode is test, so the API start-up check would refuse it', () => {
    expect(env.nodeEnv).toBe('test');
    expect(() => assertServerMode(env.nodeEnv)).toThrow(/NODE_ENV=test/);
  });

  test('an unset NODE_ENV resolves to development, which is allowed (how server.js calls the guard)', () => {
    // env.js resolves a missing NODE_ENV to "development" before the guard sees it.
    const source = fs.readFileSync(path.join(__dirname, '../../src/config/env.js'), 'utf8');
    expect(source).toContain("process.env.NODE_ENV || 'development'");
    expect(() => assertServerMode('development')).not.toThrow();
  });
});

describe('server.js start-up order (static check of the source text; the server is not started)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/server.js'), 'utf8');
  const at = (text) => source.indexOf(text);

  test('checks the mode first, before database/auth checks and before the app is loaded', () => {
    expect(at('assertServerMode(')).toBeGreaterThan(-1);
    expect(at('assertServerMode(')).toBeLessThan(at('assertDbConfig('));
    expect(at('assertServerMode(')).toBeLessThan(at('assertAuthConfig('));
    expect(at('assertServerMode(')).toBeLessThan(at("require('./app')"));
  });

  test('passes the resolved mode and exits with the existing convention on failure', () => {
    expect(source).toContain('assertServerMode(env.nodeEnv)');
    expect(source).toContain('Configuration error:');
    expect(source).toContain('process.exit(1)');
  });
});
