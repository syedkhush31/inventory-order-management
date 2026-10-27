// Auth behaviour with the admin repository mocked: no database is touched.
// All secrets and passwords here are random values generated for this run.
const crypto = require('crypto');

process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.CLIENT_ORIGIN = 'http://localhost:5173';

jest.mock('../../src/repositories/adminRepository', () => ({
  findByEmail: jest.fn(),
  findById: jest.fn(),
  countAll: jest.fn(),
  create: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const adminRepository = require('../../src/repositories/adminRepository');
const authService = require('../../src/services/authService');
const authenticate = require('../../src/middleware/authenticate');
const createAuthRouter = require('../../src/routes/authRoutes');
const { createLoginLimiter } = require('../../src/middleware/rateLimiters');
const { errorHandler } = require('../../src/middleware/errorHandler');
const app = require('../../src/app');

const ORIGIN = 'http://localhost:5173';
const EMAIL = 'admin@example.com';
const PASSWORD = crypto.randomBytes(12).toString('hex');
let admin; // row as the repository would return it

function cookieFrom(res) {
  return (res.headers['set-cookie'] || []).find((c) => c.startsWith('admin_token='));
}

function tokenFor(id, options = {}) {
  return jwt.sign({}, process.env.JWT_SECRET, { algorithm: 'HS256', subject: String(id), expiresIn: 60, ...options });
}

beforeAll(async () => {
  admin = { id: 7, email: EMAIL, password_hash: await authService.hashPassword(PASSWORD), is_active: 1 };
});

beforeEach(() => {
  adminRepository.findByEmail.mockImplementation(async (email) => (email === EMAIL ? admin : null));
  adminRepository.findById.mockImplementation(async (id) => (id === admin.id ? admin : null));
  admin.is_active = 1;
});

describe('password hashing', () => {
  test('stores a bcrypt hash, not the password', () => {
    expect(admin.password_hash).toMatch(/^\$2[aby]\$12\$/);
    expect(admin.password_hash).not.toContain(PASSWORD);
  });
});

// Note: the real login limiter allows 10 failed attempts per IP; this block makes fewer than that.
describe('POST /api/auth/login', () => {
  test('sets an HttpOnly SameSite=Lax cookie and returns no secrets', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ admin: { id: 7, email: EMAIL } });
    expect(JSON.stringify(res.body)).not.toMatch(/hash|password/i);

    const cookie = cookieFrom(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/;\s*Secure/i); // Secure only in production
    expect(cookie).toMatch(/Max-Age=3600/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('wrong password and unknown email give the same generic 401', async () => {
    const wrong = await request(app).post('/api/auth/login').send({ email: EMAIL, password: 'wrong-password' });
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(cookieFrom(wrong)).toBeUndefined();
  });

  test('deactivated admin cannot log in', async () => {
    admin.is_active = 0;
    const res = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(401);
  });

  test('rejects invalid input with 400', async () => {
    const missing = await request(app).post('/api/auth/login').send({});
    const badEmail = await request(app).post('/api/auth/login').send({ email: 'nope', password: 'x' });
    expect(missing.status).toBe(400);
    expect(badEmail.status).toBe(400);
  });

  test('malformed JSON gives a generic 400', async () => {
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid JSON' });
  });

  test('oversized body is rejected', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: EMAIL, password: 'a'.repeat(20000) });
    expect(res.status).toBe(413);
  });
});

describe('cross-origin protection', () => {
  test('blocks state-changing requests from another origin', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://evil.example')
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(cookieFrom(res)).toBeUndefined();
  });

  test('blocks requests the browser marks cross-site, even without Origin', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Sec-Fetch-Site', 'cross-site');
    expect(res.status).toBe(403);
  });

  test('allows the configured frontend origin and returns credentialed CORS headers', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  test('does not restrict safe (GET) requests', async () => {
    const res = await request(app).get('/api/auth/me').set('Origin', 'http://evil.example');
    expect(res.status).toBe(401); // reaches the auth check instead of being blocked
  });
});

describe('GET /api/auth/me and the authenticate middleware', () => {
  test('401 without a cookie', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
  });

  test('200 with the cookie from a real login', async () => {
    const login = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    const res = await request(app).get('/api/auth/me').set('Cookie', cookieFrom(login).split(';')[0]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ admin: { id: 7, email: EMAIL } });
  });

  test.each([
    ['garbage token', () => 'not-a-jwt'],
    ['tampered signature', () => `${tokenFor(7)}x`],
    ['expired token', () => tokenFor(7, { expiresIn: -10 })],
    ['wrong secret', () => jwt.sign({}, 'a-different-secret-of-some-length-1234', { subject: '7', expiresIn: 60 })],
    ['alg none', () => {
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: '7', exp: Math.floor(Date.now() / 1000) + 60 })}.`;
    }],
    ['non-numeric subject', () => tokenFor('abc')],
    ['admin that does not exist', () => tokenFor(999)],
  ])('401 for %s', async (_name, makeToken) => {
    const res = await request(app).get('/api/auth/me').set('Cookie', `admin_token=${makeToken()}`);
    expect(res.status).toBe(401);
  });

  test('a valid token stops working once the admin is deactivated', async () => {
    admin.is_active = 0;
    const res = await request(app).get('/api/auth/me').set('Cookie', `admin_token=${tokenFor(7)}`);
    expect(res.status).toBe(401);
  });

  test('authenticate protects any route it is attached to', async () => {
    const mini = express();
    mini.use(require('cookie-parser')());
    mini.get('/secret', authenticate, (req, res) => res.json({ ok: true, who: req.admin.email }));
    mini.use(errorHandler);

    expect((await request(mini).get('/secret')).status).toBe(401);
    const ok = await request(mini).get('/secret').set('Cookie', `admin_token=${tokenFor(7)}`);
    expect(ok.status).toBe(200);
    expect(ok.body.who).toBe(EMAIL);
  });
});

describe('POST /api/auth/logout', () => {
  test('clears the cookie', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    const cookie = cookieFrom(res);
    expect(cookie).toMatch(/^admin_token=;/);
    expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cookie).toMatch(/HttpOnly/i);
  });
});

describe('login rate limiting', () => {
  test('blocks an IP after too many failed attempts but not successful ones', async () => {
    const mini = express();
    mini.use(express.json());
    mini.use('/api/auth', createAuthRouter({ loginLimiter: createLoginLimiter({ limit: 3 }) }));

    await request(mini).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD }); // success: not counted
    for (let i = 0; i < 3; i += 1) {
      const res = await request(mini).post('/api/auth/login').send({ email: EMAIL, password: 'wrong-password' });
      expect(res.status).toBe(401);
    }
    const blocked = await request(mini).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/too many/i);
  });
});

describe('error handling', () => {
  test('unknown routes return a generic 404', async () => {
    const res = await request(app).get('/api/nothing-here');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  test('internal errors never leak details', async () => {
    adminRepository.findByEmail.mockRejectedValue(new Error('SELECT secret FROM somewhere'));
    const res = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
