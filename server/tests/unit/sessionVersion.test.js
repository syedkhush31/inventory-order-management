// Session versions (token_version): a login token carries the version in a `tv` claim, and only works while it equals
// the administrator's current version in the database. A token without the claim is version 0, so every login that
// existed before this feature keeps working until the password is changed. Repositories are mocked: no database.
const crypto = require('crypto');

process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.CLIENT_ORIGIN = 'http://localhost:5173';

jest.mock('../../src/config/db', () => ({ withTransaction: jest.fn(), getPool: jest.fn() }));
jest.mock('../../src/repositories/adminRepository', () => ({
  findByEmail: jest.fn(),
  findById: jest.fn(),
  findProfile: jest.fn(),
  countAll: jest.fn(),
  create: jest.fn(),
  findForUpdate: jest.fn(),
  updateProfile: jest.fn(),
  updatePasswordAndBumpVersion: jest.fn(),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const adminRepository = require('../../src/repositories/adminRepository');
const authService = require('../../src/services/authService');
const app = require('../../src/app');

const EMAIL = 'admin@example.com';
const PASSWORD = crypto.randomBytes(12).toString('hex');
let row;

// A token the way the code signs it, or an old one signed before sessions had versions (claims = undefined).
const tokenFor = (id, claims, options = {}) =>
  jwt.sign(claims === undefined ? {} : claims, process.env.JWT_SECRET, { algorithm: 'HS256', subject: String(id), expiresIn: 60, ...options });
const me = (token) => request(app).get('/api/auth/me').set('Cookie', `admin_token=${token}`);
const cookieFrom = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith('admin_token='));

beforeAll(async () => {
  row = { id: 7, email: EMAIL, password_hash: await authService.hashPassword(PASSWORD), is_active: 1, token_version: 0 };
});

beforeEach(() => {
  row.is_active = 1;
  row.token_version = 0;
  adminRepository.findByEmail.mockImplementation(async (email) => (email === EMAIL ? row : null));
  adminRepository.findById.mockImplementation(async (id) => (id === row.id ? row : null));
});

describe('signToken and readToken', () => {
  test('a new token carries the version in the tv claim', () => {
    const decoded = jwt.decode(authService.signToken({ id: 7, tokenVersion: 3 }));
    expect(decoded.sub).toBe('7');
    expect(decoded.tv).toBe(3);
    expect(authService.readToken(authService.signToken({ id: 7, tokenVersion: 3 }))).toEqual({ adminId: 7, tokenVersion: 3 });
  });

  test('an admin object without a version signs version 0', () => {
    expect(jwt.decode(authService.signToken({ id: 7 })).tv).toBe(0);
  });

  test('a token without the tv claim (issued before this feature) is version 0', () => {
    expect(authService.readToken(tokenFor(7))).toEqual({ adminId: 7, tokenVersion: 0 });
    expect(authService.verifyToken(tokenFor(7))).toBe(7);
  });

  test.each([
    ['a negative version', -1],
    ['a decimal version', 1.5],
    ['a text version', '1'],
    ['a null version', null],
    ['a boolean version', true],
    ['an object version', { n: 1 }],
    ['a huge version', 2 ** 60],
  ])('%s is not a valid token', (_label, tv) => {
    expect(authService.readToken(tokenFor(7, { tv }))).toBeNull();
    expect(authService.verifyToken(tokenFor(7, { tv }))).toBeNull();
  });

  test('a bad subject, a bad signature or an expired token is still refused', () => {
    expect(authService.readToken(tokenFor('abc'))).toBeNull();
    expect(authService.readToken(`${tokenFor(7)}x`)).toBeNull();
    expect(authService.readToken(tokenFor(7, undefined, { expiresIn: -10 }))).toBeNull();
    expect(authService.readToken('not-a-jwt')).toBeNull();
  });

  test('versionOf treats a missing or odd database value as 0', () => {
    expect(authService.versionOf({})).toBe(0);
    expect(authService.versionOf({ token_version: null })).toBe(0);
    expect(authService.versionOf({ token_version: '4' })).toBe(4);
    expect(authService.versionOf({ token_version: -2 })).toBe(0);
    expect(authService.versionOf({ token_version: 'abc' })).toBe(0);
  });
});

describe('the authenticate middleware compares the token version with the database', () => {
  test('an old token without tv works while the admin is at version 0 (nobody is signed out by the migration)', async () => {
    expect((await me(tokenFor(7))).status).toBe(200);
    expect((await me(tokenFor(7, { tv: 0 }))).status).toBe(200);
  });

  test('a row with no token_version at all (a database from before migration 003) counts as 0', async () => {
    delete row.token_version;
    expect((await me(tokenFor(7))).status).toBe(200);
    row.token_version = 0;
  });

  test('once the version has gone up, every older token is refused at once', async () => {
    row.token_version = 1;
    expect((await me(tokenFor(7))).status).toBe(401); // an old token without tv
    expect((await me(tokenFor(7, { tv: 0 }))).status).toBe(401);
    expect((await me(tokenFor(7, { tv: 1 }))).status).toBe(200); // the new session
  });

  test('a token from the future (a higher version than the database) is refused too', async () => {
    expect((await me(tokenFor(7, { tv: 5 }))).status).toBe(401);
  });

  test('the check applies to every protected area, not just /me', async () => {
    row.token_version = 2;
    for (const url of ['/api/products', '/api/customers', '/api/orders', '/api/activity', '/api/account', '/api/settings']) {
      const old = await request(app).get(url).set('Cookie', `admin_token=${tokenFor(7, { tv: 1 })}`);
      expect({ url, status: old.status }).toEqual({ url, status: 401 });
    }
  });

  test('a deactivated admin is still refused whatever the version', async () => {
    row.is_active = 0;
    expect((await me(tokenFor(7, { tv: 0 }))).status).toBe(401);
  });

  test('getActiveAdmin returns only the id and email', async () => {
    expect(await authService.getActiveAdmin(7, 0)).toEqual({ id: 7, email: EMAIL });
    expect(await authService.getActiveAdmin(7, 1)).toBeNull();
    expect(await authService.getActiveAdmin(99, 0)).toBeNull();
  });
});

describe('login', () => {
  test('issues a cookie whose token carries the current version, and returns no version', async () => {
    row.token_version = 4;
    const res = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ admin: { id: 7, email: EMAIL } });
    expect(JSON.stringify(res.body)).not.toMatch(/version|tv|hash|password/i);
    const token = cookieFrom(res).split(';')[0].replace('admin_token=', '');
    expect(jwt.decode(token).tv).toBe(4);
    expect((await me(token)).status).toBe(200);
  });

  test('a row without token_version logs in as version 0', async () => {
    delete row.token_version;
    const res = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(jwt.decode(cookieFrom(res).split(';')[0].replace('admin_token=', '')).tv).toBe(0);
    row.token_version = 0;
  });

  test('verifyCredentials returns the session version for the cookie but login never sends it back', async () => {
    row.token_version = 2;
    expect(await authService.verifyCredentials(EMAIL, PASSWORD)).toEqual({ id: 7, email: EMAIL, tokenVersion: 2 });
  });

  test('the existing cookie settings are unchanged', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    const cookie = cookieFrom(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=3600/);
  });
});
