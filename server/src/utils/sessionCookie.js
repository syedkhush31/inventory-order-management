// The login cookie: one place for its settings, so login, logout and a password change all use exactly the same ones.
// HttpOnly (scripts can not read it), SameSite=Lax, Secure in production, valid for the lifetime of the token.
const env = require('../config/env');

function cookieOptions() {
  return { httpOnly: true, sameSite: 'lax', secure: env.cookie.secure, path: '/' };
}

// Sets the login cookie to `token` on the response. Used after a login and after a password change.
function setSessionCookie(res, token) {
  res.cookie(env.cookie.name, token, { ...cookieOptions(), maxAge: env.jwt.expiresInSeconds * 1000 });
}

function clearSessionCookie(res) {
  res.clearCookie(env.cookie.name, cookieOptions());
}

module.exports = { cookieOptions, setSessionCookie, clearSessionCookie };
