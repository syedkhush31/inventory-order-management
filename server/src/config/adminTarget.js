// Safety guards for scripts that create administrators. Pure functions: no database access,
// and this file deliberately does not load any .env file.
const DEV_DATABASE_NAME = 'inventory_dev';
const DEV_ENV_FILE = '.env';

// Call BEFORE loading config. Only an unset/empty NODE_ENV or exactly "development" is accepted;
// any other value (for example a leftover "test" in the terminal) is refused, never overridden.
function assertDevelopmentMode(rawNodeEnv) {
  if (rawNodeEnv === undefined || rawNodeEnv === '' || rawNodeEnv === 'development') {
    return;
  }
  throw new Error(
    'NODE_ENV is set in this terminal to a value other than "development". ' +
      'Clear it first (PowerShell: Remove-Item Env:NODE_ENV) or open a new terminal.'
  );
}

// Call after loading config: the loaded file and configured database must be the dev ones.
function assertConfiguredTarget({ nodeEnv, envFile, dbName }) {
  if (nodeEnv !== 'development') {
    throw new Error('Refusing to run: the app is not in development mode.');
  }
  if (envFile !== DEV_ENV_FILE) {
    throw new Error(`Refusing to run: configuration was not loaded from server/${DEV_ENV_FILE}.`);
  }
  if (dbName !== DEV_DATABASE_NAME) {
    throw new Error(`Refusing to run: configured database is not exactly "${DEV_DATABASE_NAME}".`);
  }
}

// Call with the result of SELECT DATABASE() before prompting for anything.
function assertLiveTarget(liveName) {
  if (liveName !== DEV_DATABASE_NAME) {
    throw new Error(`Refusing to run: connected database is not exactly "${DEV_DATABASE_NAME}".`);
  }
}

// The typed confirmation must equal the database name exactly.
function assertConfirmation(typed) {
  if (typed !== DEV_DATABASE_NAME) {
    throw new Error('Confirmation did not match. Nothing was created.');
  }
}

module.exports = {
  DEV_DATABASE_NAME,
  DEV_ENV_FILE,
  assertDevelopmentMode,
  assertConfiguredTarget,
  assertLiveTarget,
  assertConfirmation,
};
