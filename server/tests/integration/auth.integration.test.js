// End-to-end auth tests against the real MySQL TEST database (inventory_test).
// This file WRITES to the database: it empties the tables before and after the run.
// Safety: NODE_ENV is "test" under Jest, so config comes from server/.env.test, and
// resetTestDatabase() refuses to run unless the connected database is exactly "inventory_test".
// The admin password is random for every run and is never stored in the repo.
const crypto = require('crypto');
const request = require('supertest');
const env = require('../../src/config/env');
const { getPool, closePool } = require('../../src/config/db');
const adminRepository = require('../../src/repositories/adminRepository');
const authService = require('../../src/services/authService');
const { resetTestDatabase } = require('../helpers/resetDb');
const app = require('../../src/app');

const EMAIL = 'integration-admin@example.com';
const PASSWORD = crypto.randomBytes(16).toString('hex');

function cookieFrom(res) {
  return (res.headers['set-cookie'] || []).find((c) => c.startsWith('admin_token='));
}

beforeAll(async () => {
  // Safety checks first. If any of them fails, nothing below runs, so nothing is written.
  expect(env.nodeEnv).toBe('test');
  env.assertDbConfig();
  env.assertAuthConfig();
  expect(env.db.name).toBe('inventory_test');
  const [[live]] = await getPool().query('SELECT DATABASE() AS db'); // read-only
  expect(live.db).toBe('inventory_test');

  await resetTestDatabase(); // repeats the same checks, then clears the tables
  const passwordHash = await authService.hashPassword(PASSWORD);
  await adminRepository.create({ email: EMAIL, passwordHash });
});

afterAll(async () => {
  try {
    await resetTestDatabase();
  } finally {
    await closePool();
  }
});

test('connects to the test database only', async () => {
  const [[row]] = await getPool().query('SELECT DATABASE() AS db');
  expect(row.db).toBe('inventory_test');
});

test('the stored password is a bcrypt hash, never the plaintext', async () => {
  const [rows] = await getPool().execute('SELECT password_hash FROM admins WHERE email = ?', [EMAIL]);
  expect(rows[0].password_hash).toMatch(/^\$2[aby]\$12\$/);
  expect(rows[0].password_hash).not.toContain(PASSWORD);
});

test('duplicate admin emails are rejected by the database', async () => {
  await expect(adminRepository.create({ email: EMAIL, passwordHash: 'x' })).rejects.toMatchObject({
    code: 'ER_DUP_ENTRY',
  });
});

test('login, /me and logout work end to end', async () => {
  const login = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
  expect(login.status).toBe(200);
  expect(login.body.admin.email).toBe(EMAIL);
  expect(JSON.stringify(login.body)).not.toMatch(/hash|password/i);

  const cookie = cookieFrom(login);
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/SameSite=Lax/i);

  const me = await request(app).get('/api/auth/me').set('Cookie', cookie.split(';')[0]);
  expect(me.status).toBe(200);
  expect(me.body.admin.email).toBe(EMAIL);

  const logout = await request(app).post('/api/auth/logout');
  expect(logout.status).toBe(200);
  expect(cookieFrom(logout)).toMatch(/^admin_token=;/);
});

test('wrong password and unknown email are both a generic 401', async () => {
  const wrong = await request(app).post('/api/auth/login').send({ email: EMAIL, password: 'not-the-password' });
  const unknown = await request(app).post('/api/auth/login').send({ email: 'ghost@example.com', password: PASSWORD });
  expect(wrong.status).toBe(401);
  expect(unknown.status).toBe(401);
  expect(wrong.body).toEqual(unknown.body);
});

test('a deactivated admin loses access immediately, even with a valid token', async () => {
  const login = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
  const cookie = cookieFrom(login).split(';')[0];

  await getPool().execute('UPDATE admins SET is_active = 0 WHERE email = ?', [EMAIL]);
  try {
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(401);
    const relogin = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(relogin.status).toBe(401);
  } finally {
    await getPool().execute('UPDATE admins SET is_active = 1 WHERE email = ?', [EMAIL]);
  }
});

test('SQL injection text in the email is treated as plain data', async () => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: "x@example.com' OR '1'='1", password: PASSWORD });
  expect(res.status).toBe(400); // fails email validation before reaching the database
});
