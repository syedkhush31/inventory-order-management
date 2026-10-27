const rateLimit = require('express-rate-limit');

// Limits failed login attempts per IP. Successful logins are not counted.
function createLoginLimiter({ windowMs = 15 * 60 * 1000, limit = 10 } = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (req, res) => {
      res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
    },
  });
}

module.exports = { createLoginLimiter };
