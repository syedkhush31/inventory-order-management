// Protects a route: requires a valid auth cookie belonging to an active admin.
const env = require('../config/env');
const authService = require('../services/authService');

async function authenticate(req, res, next) {
  const token = req.cookies && req.cookies[env.cookie.name];
  const adminId = typeof token === 'string' ? authService.verifyToken(token) : null;
  const admin = adminId ? await authService.getActiveAdmin(adminId) : null;

  if (!admin) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.admin = admin;
  return next();
}

module.exports = authenticate;
