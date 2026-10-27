// Loads environment variables and exposes them in one place.
// Development reads server/.env; tests (NODE_ENV=test) read server/.env.test.
// Importing this file never throws. Call assertDbConfig() before touching the database.
const path = require('path');
const dotenv = require('dotenv');

const nodeEnv = process.env.NODE_ENV || 'development';
const envFile = nodeEnv === 'test' ? '.env.test' : '.env';
dotenv.config({ path: path.join(__dirname, '..', '..', envFile), quiet: true });

const config = {
  nodeEnv,
  envFile,
  port: Number(process.env.PORT) || 5000,
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  db: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    name: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresInSeconds: 60 * 60, // fixed 1-hour lifetime, no refresh token
  },
  cookie: {
    name: 'admin_token',
    secure: nodeEnv === 'production',
  },
};

const MIN_JWT_SECRET_LENGTH = 32;
const PLACEHOLDER_SECRET_PATTERN = /^replace_with/i;

// Throws if the JWT secret is missing, too short or still the example placeholder.
// The secret itself is never included in the message.
function assertAuthConfig(env = process.env) {
  const secret = env.JWT_SECRET;
  if (!secret || secret.trim() === '') {
    throw new Error(`Missing required environment variable: JWT_SECRET. Set it in server/${envFile}.`);
  }
  if (secret.length < MIN_JWT_SECRET_LENGTH || PLACEHOLDER_SECRET_PATTERN.test(secret)) {
    throw new Error(
      `JWT_SECRET must be a real random value of at least ${MIN_JWT_SECRET_LENGTH} characters.`
    );
  }
}

const TEST_DATABASE_NAME = 'inventory_test';
const REQUIRED_DB_VARS =['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];

// Throws a clear error that names missing variables but never prints their values.
function assertDbConfig(env = process.env, mode = nodeEnv) {
  const missing = REQUIRED_DB_VARS.filter((key) => !env[key] || env[key].trim() === '');
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        `Set them in server/${envFile} (see the .example file).`
    );
  }

  // Keep dev and test data apart: test mode may only use exactly inventory_test,
  // and every other mode must not use any database whose name ends in _test.
  if (mode === 'test' && env.DB_NAME !== TEST_DATABASE_NAME) {
    throw new Error(`Refusing to run tests: DB_NAME must be exactly "${TEST_DATABASE_NAME}".`);
  }
  if (mode !== 'test' && env.DB_NAME.endsWith('_test')) {
    throw new Error('Refusing to start: DB_NAME ends with "_test" outside of test mode.');
  }
}

const SERVER_MODES = ['development', 'production'];

// Guard for starting the API (server.js). Only "development" and "production" may serve requests.
// "test" is reserved for the automated tests, because it makes the app use the test database.
// This only checks the mode name; it never reads or prints environment-file values.
function assertServerMode(mode) {
  if (typeof mode !== 'string' || mode.trim() === '') {
    throw new Error('NODE_ENV is empty or missing. Use "development" or "production" to start the API.');
  }
  if (mode === 'test') {
    throw new Error(
      'Refusing to start the API with NODE_ENV=test: test mode is reserved for automated tests and uses the ' +
        'test database. Clear NODE_ENV (PowerShell: Remove-Item Env:NODE_ENV) or open a new terminal.'
    );
  }
  if (!SERVER_MODES.includes(mode)) {
    throw new Error(
      `Unsupported NODE_ENV "${mode.slice(0, 30)}". Use "development" or "production" to start the API.`
    );
  }
}

module.exports = config;
module.exports.assertServerMode = assertServerMode;
module.exports.assertDbConfig = assertDbConfig;
module.exports.assertAuthConfig = assertAuthConfig;
module.exports.TEST_DATABASE_NAME = TEST_DATABASE_NAME;
