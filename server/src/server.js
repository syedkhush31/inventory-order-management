// Starts the HTTP server. Kept separate from app.js so tests can import the app alone.
// Configuration is validated first so the server fails fast with a clear message.
const env = require('./config/env');

try {
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
