// Starts the HTTP server. Kept separate from app.js so tests can import the app alone.
// Configuration is validated first so the server fails fast with a clear message.
const env = require('./config/env');

try {
  // First check: refuse unsafe modes (such as a leftover NODE_ENV=test) before anything else runs.
  // env.nodeEnv is the resolved mode: an unset NODE_ENV means "development".
  env.assertServerMode(env.nodeEnv);
  env.assertDbConfig();
  env.assertAuthConfig();
} catch (err) {
  console.error(`Configuration error: ${err.message}`);
  process.exit(1);
}

const app = require('./app');

app.listen(env.port, () => {
  console.log(`Server listening on port ${env.port}`);
});
