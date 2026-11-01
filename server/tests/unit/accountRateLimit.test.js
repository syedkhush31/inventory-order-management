// The real app's password-change limiter, in a file of its own so its allowance starts full. Database layer faked.
const crypto = require('crypto');

process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.CLIENT_ORIGIN = 'http://localhost:5173';

jest.setTimeout(30000);

jest.mock('../../src/config/db', () => ({ withTransaction: jest.fn(), getPool: jest.fn() }));
jest.mock('../../src/repositories/auditRepository', () => ({ insert: jest.fn() }));
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
const bcrypt = require('bcryptjs');
const db = require('../../src/config/db');
const adminRepository = require('../../src/repositories/adminRepository');
const app = require('../../src/app');

const PASSWORD = crypto.randomBytes(12).toString('hex');
const NEW_PASSWORD = `${crypto.randomBytes(12).toString('hex')}Zz9`;
const cookie = () => `admin_token=${jwt.sign({}, process.env.JWT_SECRET, { algorithm: 'HS256', subject: '7', expiresIn: 600 })}`;

let row;

beforeAll(async () => {
  row = { id: 7, email: 'admin@example.com', display_name: null, password_hash: await bcrypt.hash(PASSWORD, 4), is_active: 1, token_version: 0, created_at: new Date() };
});

beforeEach(() => {
  adminRepository.findById.mockImplementation(async () => ({ id: 7, email: row.email, is_active: 1, token_version: 0 }));
  adminRepository.findForUpdate.mockImplementation(async () => ({ ...row }));
  db.withTransaction.mockImplementation(async (fn) => fn({ query: jest.fn() }));
});

test('the real app limits wrong current passwords: five 403s, then 429 on BOTH routes, and the right password is not even tried', async () => {
  const wrong = () => request(app).post('/api/account/password').set('Cookie', cookie()).send({ currentPassword: 'wrong-password', newPassword: NEW_PASSWORD });
  for (let i = 0; i < 5; i += 1) {
    expect((await wrong()).status).toBe(403);
  }
  const blockedPassword = await request(app).post('/api/account/password').set('Cookie', cookie()).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
  expect(blockedPassword.status).toBe(429);
  expect(blockedPassword.body.error).toMatch(/too many/i);
  expect(blockedPassword.headers['set-cookie']).toBeUndefined();

  const blockedEmail = await request(app).patch('/api/account/profile').set('Cookie', cookie()).send({ email: 'x@example.com', currentPassword: PASSWORD });
  expect(blockedEmail.status).toBe(429);

  expect(adminRepository.updatePasswordAndBumpVersion).not.toHaveBeenCalled();
  expect(adminRepository.updateProfile).not.toHaveBeenCalled();
});

test('the limiter sits behind authentication: an anonymous caller gets 401, not a counted attempt', async () => {
  const res = await request(app).post('/api/account/password').send({ currentPassword: 'x', newPassword: NEW_PASSWORD });
  expect(res.status).toBe(401);
});

test('in the real app, once the allowance is used up display-name changes and same-address "changes" still work', async () => {
  // (the test above has already used up this administrator's allowance in this file)
  const blocked = await request(app).post('/api/account/password').set('Cookie', cookie()).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
  expect(blocked.status).toBe(429);

  const name = await request(app).patch('/api/account/profile').set('Cookie', cookie()).send({ displayName: 'Still allowed' });
  expect(name.status).toBe(200);
  expect(name.body.account.displayName).toBe('Still allowed');

  const sameEmail = await request(app).patch('/api/account/profile').set('Cookie', cookie()).send({ email: row.email });
  expect(sameEmail.status).toBe(200);

  const newEmail = await request(app).patch('/api/account/profile').set('Cookie', cookie()).send({ email: 'new@example.com', currentPassword: PASSWORD });
  expect(newEmail.status).toBe(429); // an email change is still protected
});
