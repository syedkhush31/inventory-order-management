// Protects a route: requires a valid auth cookie belonging to an active admin, whose session version still matches.
const env = require('../config/env');
const authService = require('../services/authService');

async function authenticate(req, res, next) {
  const token = req.cookies && req.cookies[env.cookie.name];
  const session = typeof token === 'string' ? authService.readToken(token) : null;
  const admin = session ? await authService.getActiveAdmin(session.adminId, session.tokenVersion) : null;

  if (!admin) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.admin = admin;
  return next();
}

module.exports = authenticate;
