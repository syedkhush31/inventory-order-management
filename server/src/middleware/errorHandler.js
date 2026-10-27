// Final handlers. Clients only ever see generic messages, never stack traces or SQL.
const env = require('../config/env');

function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request too large' });
  }
  if (env.nodeEnv !== 'test') {
    // Log only a short category: database error messages can contain query text and values.
    console.error(`Unhandled error: ${err.code || err.name}`);
  }
  return res.status(500).json({ error: 'Internal server error' });
}

module.exports = { notFound, errorHandler };
