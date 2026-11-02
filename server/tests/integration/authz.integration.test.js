// Authentication and authorization against the real MySQL TEST database (inventory_test): every protected route
// refuses a missing or forged session, tokens are checked against the database on every request, the same-origin (CSRF)
// rule, the login limiter, and what the login and logout responses and cookies contain.
// This file WRITES to the test database: every test starts from empty tables (resetTestDatabase) and the tables are
// emptied again afterwards. See tests/helpers/integrationEnv.js for the guards that refuse to run against anything but
// inventory_test.
//
// This is separate from auth.integration.test.js (the original suite, which is left unchanged).
const jwt = require('jsonwebtoken');
const env = require('../../src/config/env');
const { INTEGRATION_TIMEOUT, query, useIntegrationDatabase } = require('../helpers/integrationEnv');
const db = require('../helpers/dbAssert');
const { client, cookieFor, loginCookie, rawSessionCookie } = require('../helpers/http');
const { freshApp } = require('../helpers/freshApp');
const { assertNoSecrets } = require('../helpers/privacy');

jest.setTimeout(INTEGRATION_TIMEOUT);

const ctx = useIntegrationDatabase();

const NOT_SIGNED_IN = { error: 'Authentication required' };
const DATA_TABLES = ['products', 'customers', 'orders', 'order_items', 'order_status_history', 'stock_adjustments', 'audit_log', 'app_settings'];

// ------------------------------------------------------------------------------------------ every protected route
// All 26 routes that need a session (everything under /api except login and logout). The id 1 need not exist: the session
// is checked before anything else.
const PROTECTED_ROUTES = [
  ['get', '/api/auth/me'],
  ['get', '/api/products'],
  ['post', '/api/products', {}],
  ['patch', '/api/products/1', {}],
  ['post', '/api/products/1/deactivate'],
  ['post', '/api/products/1/reactivate'],
  ['get', '/api/products/1/stock-adjustments'],
  ['post', '/api/products/1/stock-adjustments', {}],
  ['get', '/api/customers'],
  ['post', '/api/customers', {}],
  ['patch', '/api/customers/1', {}],
  ['post', '/api/customers/1/deactivate'],
  ['post', '/api/customers/1/reactivate'],
  ['get', '/api/orders'],
  ['post', '/api/orders', {}],
  ['get', '/api/orders/1'],
  ['post', '/api/orders/1/confirm'],
  ['post', '/api/orders/1/cancel'],
  ['post', '/api/orders/1/ship'],
  ['post', '/api/orders/1/deliver'],
  ['get', '/api/activity'],
  ['get', '/api/account'],
  ['patch', '/api/account/profile', {}],
  ['post', '/api/account/password', {}],
  ['get', '/api/settings'],
  ['patch', '/api/settings', {}],
];

describe('AUTH-1: every protected route needs a valid session', () => {
  test('AUTH-1 the list covers 26 routes', () => {
    expect(PROTECTED_ROUTES).toHaveLength(26);
  });

  // The callback takes ...row (arity 0) on purpose: with a fixed (method, path, body) signature, Jest hands its own `done`
  // callback to the `body` parameter of every row that has no body.
  test.each(PROTECTED_ROUTES)('AUTH-1 %s %s is 401 without a cookie and with a forged one, and writes nothing', async (...row) => {
    const [method, path] = row;
    const body = row.length > 2 ? row[2] : undefined;
    const forged = jwt.sign({ tv: 0 }, 'a-secret-the-server-does-not-know-0123456789', {
      algorithm: 'HS256',
      subject: String(ctx.admin.id),
      expiresIn: 60,
    });

    for (const cookie of [null, `${env.cookie.name}=${forged}`]) {
      const res = await client(ctx.app, cookie)[method](path, body);
      expect([cookie === null ? 'no cookie' : 'forged cookie', res.status, res.body]).toEqual([
        cookie === null ? 'no cookie' : 'forged cookie',
        401,
        NOT_SIGNED_IN,
      ]);
    }
    expect(Object.values(await db.countsOf(DATA_TABLES)).every((n) => n === 0)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------- bad tokens
describe('AUTH-2 to AUTH-5: tokens are checked on every request', () => {
  const me = (cookie) => client(ctx.app, cookie).get('/api/auth/me');
  const secret = () => env.jwt.secret;
  const asCookie = (token) => `${env.cookie.name}=${token}`;
  const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const inAMinute = () => Math.floor(Date.now() / 1000) + 60;

  test('AUTH-2 only a properly signed, unexpired, well-formed token is accepted', async () => {
    const sign = (claims, options = {}) =>
      jwt.sign(claims, secret(), { algorithm: 'HS256', subject: String(ctx.admin.id), expiresIn: 60, ...options });
    const rejected = {
      'garbage text': 'not.a.jwt',
      'a token signed with another secret': jwt.sign({ tv: 0 }, 'another-secret-another-secret-another-0123', { algorithm: 'HS256', subject: String(ctx.admin.id), expiresIn: 60 }),
      'an unsigned (alg none) token': `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ sub: String(ctx.admin.id), tv: 0, exp: inAMinute() })}.`,
      'a token signed with HS512 instead of HS256': sign({ tv: 0 }, { algorithm: 'HS512' }),
      'an expired token': jwt.sign({ tv: 0, exp: Math.floor(Date.now() / 1000) - 60 }, secret(), { algorithm: 'HS256', subject: String(ctx.admin.id) }),
      'a token with no subject': jwt.sign({ tv: 0 }, secret(), { algorithm: 'HS256', expiresIn: 60 }),
      'a non-numeric subject': sign({ tv: 0 }, { subject: 'abc' }),
      'a negative session version': sign({ tv: -1 }),
      'a session version given as text': sign({ tv: '0' }),
      'a fractional session version': sign({ tv: 0.5 }),
    };

    for (const [name, token] of Object.entries(rejected)) {
      const res = await me(asCookie(token));
      expect([name, res.status, res.body]).toEqual([name, 401, NOT_SIGNED_IN]);
    }

    // The same token under a different cookie name is not looked at.
    const wrongName = await me(`token=${sign({ tv: 0 })}`);
    expect(wrongName.status).toBe(401);

    // Controls: the real thing works, and a token with no version at all counts as version 0 (the oldest tokens).
    expect((await me(ctx.cookie)).status).toBe(200);
    expect((await me(asCookie(sign({})))).status).toBe(200);
  });

  test('AUTH-3 a token for an administrator that does not exist is refused', async () => {
    const res = await me(cookieFor({ id: 999999999 }));

    expect(res.status).toBe(401);
    expect(res.body).toEqual(NOT_SIGNED_IN);
  });

  test('AUTH-4 a deactivated administrator loses access at once, and gets it back when reactivated', async () => {
    expect((await me(ctx.cookie)).status).toBe(200);

    await query('UPDATE admins SET is_active = 0 WHERE id = ?', [ctx.admin.id]);
    expect((await me(ctx.cookie)).status).toBe(401);
    expect((await client(ctx.app, ctx.cookie).get('/api/settings')).status).toBe(401);
    const login = await client(ctx.app, null).post('/api/auth/login', { email: ctx.admin.email, password: ctx.password });
    const unknown = await client(ctx.app, null).post('/api/auth/login', { email: 'nobody@example.test', password: ctx.password });
    expect(login.status).toBe(401);
    expect(login.body).toEqual({ error: 'Invalid email or password' });
    expect(unknown.body).toEqual(login.body); // a deactivated account looks like an unknown one

    await query('UPDATE admins SET is_active = 1 WHERE id = ?', [ctx.admin.id]);
    expect((await me(ctx.cookie)).status).toBe(200);
    expect(await loginCookie(ctx.app, ctx.admin.email, ctx.password)).toMatch(/^admin_token=/);
  });

  test('AUTH-5 a token whose session version no longer matches the database is refused', async () => {
    await query('UPDATE admins SET token_version = 1 WHERE id = ?', [ctx.admin.id]);

    expect((await me(ctx.cookie)).status).toBe(401); // minted for version 0
    expect((await me(cookieFor(ctx.admin, 1))).status).toBe(200);
    expect((await me(cookieFor(ctx.admin, 2))).status).toBe(401); // a version the database does not hold yet
  });
});

// ------------------------------------------------------------------------------------------------------ CSRF
describe('AUTH-6: the same-origin (CSRF) rule', () => {
  const allowed = env.clientOrigin.replace(/\/+$/, '');
  const product = (sku) => ({ sku, name: 'Csrf test product', price: '1.00' });

  test('AUTH-6 a state-changing request from another origin is 403 and writes nothing', async () => {
    for (const origin of ['http://evil.example', `${allowed}.evil.example`, 'null']) {
      const res = await ctx.api.post('/api/products', product('CSRF-1')).set('Origin', origin);
      expect([origin, res.status, res.body]).toEqual([origin, 403, { error: 'Forbidden' }]);
    }
    expect(await db.countRows('products')).toBe(0);
  });

  test('AUTH-6 the configured frontend origin is accepted', async () => {
    const res = await ctx.api.post('/api/products', product('CSRF-2')).set('Origin', allowed);

    expect(res.status).toBe(201);
    expect(await db.countRows('products')).toBe(1);
  });

  test('AUTH-6 with no Origin header, the browser\'s Sec-Fetch-Site decides', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const res = await ctx.api.post('/api/products', product('CSRF-3')).set('Sec-Fetch-Site', site);
      expect([site, res.status]).toEqual([site, 403]);
    }
    expect(await db.countRows('products')).toBe(0);

    expect((await ctx.api.post('/api/products', product('CSRF-4')).set('Sec-Fetch-Site', 'same-origin')).status).toBe(201);
    expect((await ctx.api.post('/api/products', product('CSRF-5')).set('Sec-Fetch-Site', 'none')).status).toBe(201);
    expect(await db.countRows('products')).toBe(2);
  });

  test('AUTH-6 reading is not blocked, and the rule also protects sign-in', async () => {
    const read = await ctx.api.get('/api/products').set('Origin', 'http://evil.example');
    expect(read.status).toBe(200);

    const login = await client(ctx.app, null)
      .post('/api/auth/login', { email: ctx.admin.email, password: ctx.password })
      .set('Origin', 'http://evil.example');
    expect(login.status).toBe(403);
    expect(login.headers['set-cookie']).toBeUndefined();
  });
});

// -------------------------------------------------------------------------------------------------- login limiter
describe('AUTH-7: the login limiter', () => {
  test('AUTH-7 ten failed sign-ins are allowed; the eleventh request is blocked, even with the right password', async () => {
    const fresh = await freshApp(); // its own limiter counters
    try {
      const api = client(fresh.app, null);
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        const res = await api.post('/api/auth/login', { email: ctx.admin.email, password: 'definitely-the-wrong-password' });
        expect([attempt, res.status]).toEqual([attempt, 401]);
      }

      const blocked = await api.post('/api/auth/login', { email: ctx.admin.email, password: 'definitely-the-wrong-password' });
      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual({ error: 'Too many login attempts. Please try again later.' });

      const rightButBlocked = await api.post('/api/auth/login', { email: ctx.admin.email, password: ctx.password });
      expect(rightButBlocked.status).toBe(429);
      expect(rightButBlocked.headers['set-cookie']).toBeUndefined();
    } finally {
      await fresh.close();
    }
  });

  test('AUTH-7 successful sign-ins are not counted against the limit', async () => {
    const fresh = await freshApp();
    try {
      const api = client(fresh.app, null);
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        const res = await api.post('/api/auth/login', { email: ctx.admin.email, password: ctx.password });
        expect([attempt, res.status]).toEqual([attempt, 200]);
      }
      const wrong = await api.post('/api/auth/login', { email: ctx.admin.email, password: 'definitely-the-wrong-password' });
      expect(wrong.status).toBe(401); // a normal refusal, not a block
    } finally {
      await fresh.close();
    }
  });
});

// ------------------------------------------------------------------------------------ login and logout responses
describe('AUTH-8: what sign-in and sign-out return', () => {
  test('AUTH-8 sign-in returns only the id and email and sets a safe cookie', async () => {
    const res = await client(ctx.app, null).post('/api/auth/login', { email: ctx.admin.email, password: ctx.password });

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body)).toEqual(['admin']);
    expect(Object.keys(res.body.admin).sort()).toEqual(['email', 'id']);
    expect(Number(res.body.admin.id)).toBe(ctx.admin.id);
    expect(res.body.admin.email).toBe(ctx.admin.email);
    assertNoSecrets(res.body, [ctx.password]);

    const cookie = rawSessionCookie(res);
    expect(cookie).toMatch(/^admin_token=.+/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=3600/);
    expect(cookie).not.toMatch(/;\s*Secure/i); // Secure is only set in production
  });

  test('AUTH-8 the email is matched in any letter case, and a wrong password and an unknown email give the same answer', async () => {
    const upper = await client(ctx.app, null).post('/api/auth/login', { email: ` ${ctx.admin.email.toUpperCase()} `, password: ctx.password });
    expect(upper.status).toBe(200);

    const wrong = await client(ctx.app, null).post('/api/auth/login', { email: ctx.admin.email, password: 'definitely-the-wrong-password' });
    const unknown = await client(ctx.app, null).post('/api/auth/login', { email: 'ghost@example.test', password: ctx.password });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  test('AUTH-8 sign-out clears the cookie', async () => {
    const res = await ctx.api.post('/api/auth/logout');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Logged out' });
    const cookie = rawSessionCookie(res);
    expect(cookie).toMatch(/^admin_token=;/);
    expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/);
  });
});
