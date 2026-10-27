// CSRF defence for cookie authentication, on top of SameSite=Lax.
// State-changing requests must come from the configured frontend origin.
// Requests with no Origin header (curl, Postman, tests) pass unless the browser
// says they are cross-site via Sec-Fetch-Site.
const env = require('../config/env');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SAME_SITE_VALUES = new Set(['same-origin', 'none']);

function requireSameOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  const allowedOrigin = env.clientOrigin.replace(/\/+$/, '');
  const origin = req.get('Origin');
  const fetchSite = req.get('Sec-Fetch-Site');

  const blocked = origin ? origin !== allowedOrigin : fetchSite && !SAME_SITE_VALUES.has(fetchSite);
  if (blocked) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  return next();
}

module.exports = requireSameOrigin;
