const express = require('express');
const authService = require('../services/authService');
const authenticate = require('../middleware/authenticate');
const { createLoginLimiter } = require('../middleware/rateLimiters');
const { loginSchema } = require('../validation/authSchemas');
const { setSessionCookie, clearSessionCookie } = require('../utils/sessionCookie');

function createAuthRouter({ loginLimiter = createLoginLimiter() } = {}) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid request',
        fields: [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))],
      });
    }

    const admin = await authService.verifyCredentials(parsed.data.email, parsed.data.password);
    if (!admin) {
      // Same message for unknown email, wrong password and deactivated account.
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    setSessionCookie(res, authService.signToken(admin));
    // Only the id and email are sent back: never the session version or anything else.
    return res.json({ admin: { id: admin.id, email: admin.email } });
  });

  router.post('/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ message: 'Logged out' });
  });

  router.get('/me', authenticate, (req, res) => {
    res.json({ admin: req.admin });
  });

  return router;
}

module.exports = createAuthRouter;
