// Guard logic for admin creation. Pure functions: no MySQL, no .env files are involved.
const {
  assertDevelopmentMode,
  assertConfiguredTarget,
  assertLiveTarget,
  assertConfirmation,
} = require('../../src/config/adminTarget');

describe('assertDevelopmentMode (NODE_ENV before config is loaded)', () => {
  test.each([undefined, '', 'development'])('allows %p', (value) => {
    expect(() => assertDevelopmentMode(value)).not.toThrow();
  });

  test.each(['test', 'production', 'Development', 'staging', ' development'])('refuses %p without overriding it', (value) => {
    expect(() => assertDevelopmentMode(value)).toThrow(/other than "development"/);
  });
});

describe('assertConfiguredTarget', () => {
  const good = { nodeEnv: 'development', envFile: '.env', dbName: 'inventory_dev' };

  test('accepts only development mode, server/.env and exactly inventory_dev', () => {
    expect(() => assertConfiguredTarget(good)).not.toThrow();
  });

  test.each([
    ['test mode', { nodeEnv: 'test' }],
    ['production mode', { nodeEnv: 'production' }],
    ['the test env file', { envFile: '.env.test' }],
    ['inventory_test', { dbName: 'inventory_test' }],
    ['othershop_test', { dbName: 'othershop_test' }],
    ['a look-alike name', { dbName: 'inventory_dev2' }],
    ['different capitalization', { dbName: 'Inventory_Dev' }],
    ['a missing name', { dbName: undefined }],
  ])('refuses %s', (_label, override) => {
    expect(() => assertConfiguredTarget({ ...good, ...override })).toThrow(/Refusing to run/);
  });
});

describe('assertLiveTarget (result of SELECT DATABASE())', () => {
  test('accepts exactly inventory_dev', () => {
    expect(() => assertLiveTarget('inventory_dev')).not.toThrow();
  });

  test.each(['inventory_test', 'othershop_test', 'mysql', 'inventory_dev ', '', null, undefined])('refuses %p', (value) => {
    expect(() => assertLiveTarget(value)).toThrow(/Refusing to run/);
  });
});

describe('assertConfirmation (typed by the user)', () => {
  test('accepts only the exact database name', () => {
    expect(() => assertConfirmation('inventory_dev')).not.toThrow();
  });

  test.each(['', 'yes', 'y', 'inventory_test', 'INVENTORY_DEV', ' inventory_dev', 'inventory_dev ', undefined])(
    'refuses %p',
    (value) => {
      expect(() => assertConfirmation(value)).toThrow(/Confirmation did not match/);
    }
  );
});
