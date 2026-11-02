// Small supertest helpers for the integration tests. Nothing here touches the database.
//
// Requests sent by supertest carry no Origin header, which the same-origin (CSRF) middleware lets through, so tests do
// not need any special headers. A test that wants to check the CSRF rule sets an Origin header itself.
const request = require('supertest');
const env = require('../../src/config/env');
const authService = require('../../src/services/authService');

// "admin_token=<jwt>" for an existing administrator, signed exactly like a real login would sign it.
// tokenVersion must equal the administrator's token_version for the cookie to be accepted (0 for a new account).
function cookieFor(admin, tokenVersion = 0) {
  return `${env.cookie.name}=${authService.signToken({ id: admin.id, tokenVersion })}`;
}

// Signs in through the real login route and returns the "admin_token=..." cookie, or null if the login was refused.
async function loginCookie(app, email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  const setCookie = (res.headers['set-cookie'] || []).find((value) => value.startsWith(`${env.cookie.name}=`));
  return setCookie ? setCookie.split(';')[0] : null;
}

// The "admin_token=..." cookie a response sets (for example after a login or a password change), or null if it sets none.
function cookieFromResponse(res) {
  const header = (res.headers['set-cookie'] || []).find((value) => value.startsWith(`${env.cookie.name}=`));
  return header ? header.split(';')[0] : null;
}

// The raw Set-Cookie header for the session cookie (with its attributes), or null.
function rawSessionCookie(res) {
  return (res.headers['set-cookie'] || []).find((value) => value.startsWith(`${env.cookie.name}=`)) || null;
}

// Returns helpers that send `cookie` (or no cookie when it is null) with every request. Each one returns the
// supertest request, so `await api.get('/api/orders')` gives a response with .status, .body and .headers, and
// extra headers can be added first: `api.post(path, body).set('Origin', 'http://evil.example')`.
function client(app, cookie) {
  const withCookie = (req) => (cookie ? req.set('Cookie', cookie) : req);
  const withBody = (req, body) => (body === undefined ? req : req.send(body));
  return {
    get: (path) => withCookie(request(app).get(path)),
    post: (path, body) => withBody(withCookie(request(app).post(path)), body),
    patch: (path, body) => withBody(withCookie(request(app).patch(path)), body),
  };
}

module.exports = { cookieFor, loginCookie, cookieFromResponse, rawSessionCookie, client };
