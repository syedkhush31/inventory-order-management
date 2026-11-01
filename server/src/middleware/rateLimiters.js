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

// Limits wrong "current password" answers on the routes that ask for it (changing the password, changing the email).
// Someone holding a stolen session must not be able to guess the password through these routes. It counts per signed-in
// administrator (so it must run after `authenticate`), and counts ONLY a wrong current password (403): a successful
// change, a validation mistake or a duplicate email is not a password guess and does not use up the allowance.
function createPasswordChangeLimiter({ windowMs = 15 * 60 * 1000, limit = 5 } = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req, res) => res.statusCode !== 403,
    keyGenerator: (req) => (req.admin ? `admin:${req.admin.id}` : 'unauthenticated'),
    handler: (req, res) => {
      res.status(429).json({ error: 'Too many incorrect password attempts. Please try again later.' });
    },
  });
}

module.exports = { createLoginLimiter, createPasswordChangeLimiter };
