const express = require('express');
const env = require('../config/env');
const authService = require('../services/authService');
const authenticate = require('../middleware/authenticate');
const { createLoginLimiter } = require('../middleware/rateLimiters');
const { loginSchema } = require('../validation/authSchemas');

function cookieOptions() {
  return { httpOnly: true, sameSite: 'lax', secure: env.cookie.secure, path: '/' };
}

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

    res.cookie(env.cookie.name, authService.signToken(admin), {
      ...cookieOptions(),
      maxAge: env.jwt.expiresInSeconds * 1000,
    });
    return res.json({ admin });
  });

  router.post('/logout', (req, res) => {
    res.clearCookie(env.cookie.name, cookieOptions());
    res.json({ message: 'Logged out' });
  });

  router.get('/me', authenticate, (req, res) => {
    res.json({ admin: req.admin });
  });

  return router;
}

module.exports = createAuthRouter;
