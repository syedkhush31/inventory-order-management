// /api/account (profile and password change) with the database layer replaced by fakes: no database is touched.
// The fake transaction records begin / commit / rollback and really puts the "admin row" back when a transaction fails,
// so these tests can prove that a password change and its session-version bump, and every audit record, are saved or
// discarded together. They do NOT prove how MySQL locks rows or that the SQL runs.
const crypto = require('crypto');

process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.CLIENT_ORIGIN = 'http://localhost:5173';

jest.setTimeout(30000); // bcrypt at cost 12 is deliberately slow

jest.mock('../../src/config/db', () => ({ withTransaction: jest.fn(), getPool: jest.fn() }));
// The real app keeps ONE password-change limiter for the whole test run, so the many wrong-password tests below would use
// up its allowance. Here the app gets a pass-through limiter; the limiter's own behaviour is tested below with explicit
// instances, and the app's real limiter has its own file (accountRateLimit.test.js).
jest.mock('../../src/middleware/rateLimiters', () => {
  const actual = jest.requireActual('../../src/middleware/rateLimiters');
  return {
    ...actual,
    createPasswordChangeLimiter: (options) => (options ? actual.createPasswordChangeLimiter(options) : (req, res, next) => next()),
  };
});
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

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../../src/config/db');
const auditRepository = require('../../src/repositories/auditRepository');
const adminRepository = require('../../src/repositories/adminRepository');
const authService = require('../../src/services/authService');
const createAccountRouter = require('../../src/routes/accountRoutes');
const { createPasswordChangeLimiter } = require('../../src/middleware/rateLimiters');
const { errorHandler } = require('../../src/middleware/errorHandler');
const app = require('../../src/app');

const EMAIL = 'admin@example.com';
const OLD_PASSWORD = crypto.randomBytes(12).toString('hex');
const NEW_PASSWORD = `${crypto.randomBytes(12).toString('hex')}Zz9`;
const CONNECTION = { name: 'the-one-transaction-connection', query: jest.fn() };

let row; // the admin row in the fake database
let events; // 'begin' | 'lock' | 'write:...' | 'audit:...' | 'commit' | 'rollback'
let auditEvents; // the objects handed to auditRepository.insert
let oldHash;

const tokenFor = (id, tv) => jwt.sign(tv === undefined ? {} : { tv }, process.env.JWT_SECRET, { algorithm: 'HS256', subject: String(id), expiresIn: 600 });
const cookie = (tv = 0) => `admin_token=${tokenFor(7, tv)}`;
const cookieFrom = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith('admin_token='));
const tokenFrom = (res) => cookieFrom(res).split(';')[0].replace('admin_token=', '');

const get = (url = '/api/account', { withCookie = true, tv = 0 } = {}) => {
  const req = request(app).get(url);
  if (withCookie) req.set('Cookie', cookie(tv));
  return req;
};
const patchProfile = (body, { withCookie = true, tv = 0 } = {}) => {
  const req = request(app).patch('/api/account/profile');
  if (withCookie) req.set('Cookie', cookie(tv));
  return req.send(body);
};
const postPassword = (body, { withCookie = true, tv = 0 } = {}) => {
  const req = request(app).post('/api/account/password');
  if (withCookie) req.set('Cookie', cookie(tv));
  return req.send(body);
};

beforeAll(async () => {
  oldHash = await bcrypt.hash(OLD_PASSWORD, 4); // a cheap hash of the current password; the NEW hash uses the real cost
});

beforeEach(() => {
  jest.resetAllMocks();
  events = [];
  auditEvents = [];
  row = {
    id: 7,
    email: EMAIL,
    display_name: null,
    password_hash: oldHash,
    is_active: 1,
    token_version: 0,
    created_at: new Date('2026-10-01T09:00:00Z'),
  };

  db.withTransaction.mockImplementation(async (fn) => {
    events.push('begin');
    const snapshot = { ...row };
    try {
      const result = await fn(CONNECTION);
      events.push('commit');
      return result;
    } catch (err) {
      Object.assign(row, snapshot); // a failed transaction leaves the row as it was
      events.push('rollback');
      throw err;
    }
  });
  adminRepository.findById.mockImplementation(async (id) => (id === row.id ? { id: row.id, email: row.email, is_active: row.is_active, token_version: row.token_version } : null));
  adminRepository.findProfile.mockImplementation(async (id) => (id === row.id ? { id: row.id, email: row.email, display_name: row.display_name, created_at: row.created_at } : null));
  adminRepository.findForUpdate.mockImplementation(async (connection, id) => {
    expect(connection).toBe(CONNECTION); // the row is locked on the transaction connection
    events.push('lock');
    return id === row.id ? { ...row } : null;
  });
  adminRepository.updateProfile.mockImplementation(async (connection, id, fields) => {
    expect(connection).toBe(CONNECTION);
    events.push('write:profile');
    if (fields.displayName !== undefined) row.display_name = fields.displayName;
    if (fields.email !== undefined) row.email = fields.email;
  });
  adminRepository.updatePasswordAndBumpVersion.mockImplementation(async (connection, id, hash) => {
    expect(connection).toBe(CONNECTION);
    events.push('write:password+version');
    row.password_hash = hash;
    row.token_version += 1;
  });
  auditRepository.insert.mockImplementation(async (connection, event) => {
    expect(connection).toBe(CONNECTION); // the audit record is written on the same transaction connection
    events.push(`audit:${event.eventType}`);
    auditEvents.push(event);
    return 1;
  });
});

describe('GET /api/account', () => {
  test('401 without a session', async () => {
    const res = await get('/api/account', { withCookie: false });
    expect(res.status).toBe(401);
    expect(adminRepository.findProfile).not.toHaveBeenCalled();
  });

  test('returns the profile in the documented shape, and nothing else', async () => {
    row.display_name = 'Sam';
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ account: { id: 7, email: EMAIL, displayName: 'Sam', createdAt: '2026-10-01T09:00:00.000Z' } });
  });

  test('never contains a hash, a password, a session version or the active flag', async () => {
    const res = await get();
    expect(JSON.stringify(res.body)).not.toMatch(/hash|password|token|version|is_active|isActive|\$2[aby]\$/i);
  });

  test('a missing display name is null', async () => {
    expect((await get()).body.account.displayName).toBeNull();
  });
});

describe('PATCH /api/account/profile: display name', () => {
  test('changes the display name without asking for the password, and audits the field name only', async () => {
    const res = await patchProfile({ displayName: '  Sam Lee  ' });
    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({ id: 7, email: EMAIL, displayName: 'Sam Lee' });
    expect(adminRepository.updateProfile).toHaveBeenCalledWith(CONNECTION, 7, { displayName: 'Sam Lee' });
    expect(events).toEqual(['begin', 'lock', 'write:profile', 'audit:ACCOUNT_PROFILE_UPDATED', 'commit']);
    expect(auditEvents).toEqual([{ adminId: 7, eventType: 'ACCOUNT_PROFILE_UPDATED', entityType: 'ACCOUNT', entityId: 7, details: { changedFields: ['displayName'] } }]);
    expect(JSON.stringify(auditEvents)).not.toMatch(/Sam|Lee/); // the name itself is not logged
  });

  test.each([[null], ['']])('%p clears the display name', async (value) => {
    row.display_name = 'Sam';
    const res = await patchProfile({ displayName: value });
    expect(res.status).toBe(200);
    expect(res.body.account.displayName).toBeNull();
    expect(adminRepository.updateProfile).toHaveBeenCalledWith(CONNECTION, 7, { displayName: null });
    expect(auditEvents[0].details).toEqual({ changedFields: ['displayName'] });
  });

  test('sending the value already in force writes nothing and audits nothing', async () => {
    row.display_name = 'Sam';
    const same = await patchProfile({ displayName: 'Sam' });
    expect(same.status).toBe(200);
    row.display_name = null;
    const alsoSame = await patchProfile({ displayName: null });
    expect(alsoSame.status).toBe(200);
    expect(adminRepository.updateProfile).not.toHaveBeenCalled();
    expect(auditRepository.insert).not.toHaveBeenCalled();
  });

  test.each([
    ['too long', { displayName: 'x'.repeat(101) }],
    ['a control character', { displayName: 'bad\u0007name' }],
    ['a number', { displayName: 5 }],
    ['an object', { displayName: { a: 1 } }],
    ['an array', { displayName: ['Sam'] }],
  ])('400 for a display name that is %s, and nothing is written', async (_label, body) => {
    const res = await patchProfile(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', fields: ['displayName'] });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('accepts the longest allowed name', async () => {
    expect((await patchProfile({ displayName: 'x'.repeat(100) })).status).toBe(200);
  });
});

describe('PATCH /api/account/profile: email', () => {
  test('needs the current password: 400 naming currentPassword, and nothing is written', async () => {
    const res = await patchProfile({ email: 'new@example.com' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', fields: ['currentPassword'] });
    expect(adminRepository.updateProfile).not.toHaveBeenCalled();
    expect(auditRepository.insert).not.toHaveBeenCalled();
    expect(events).toEqual(['begin', 'lock', 'rollback']);
  });

  test('a wrong current password is 403 (not 401, so the app does not sign the person out), and nothing is written', async () => {
    const res = await patchProfile({ email: 'new@example.com', currentPassword: 'definitely-wrong' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Current password is incorrect', fields: ['currentPassword'] });
    expect(adminRepository.updateProfile).not.toHaveBeenCalled();
    expect(auditRepository.insert).not.toHaveBeenCalled();
    expect(row.email).toBe(EMAIL);
  });

  test('the right current password changes the email, and the audit record names the field but not the address', async () => {
    const res = await patchProfile({ email: 'new@example.com', currentPassword: OLD_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.account.email).toBe('new@example.com');
    expect(adminRepository.updateProfile).toHaveBeenCalledWith(CONNECTION, 7, { email: 'new@example.com' });
    expect(events).toEqual(['begin', 'lock', 'write:profile', 'audit:ACCOUNT_PROFILE_UPDATED', 'commit']);
    expect(auditEvents[0].details).toEqual({ changedFields: ['email'] });
    expect(JSON.stringify(auditEvents)).not.toMatch(/@|example|password/i);
    expect(JSON.stringify(res.body)).not.toContain(OLD_PASSWORD);
  });

  test('the email is trimmed and lower-cased', async () => {
    const res = await patchProfile({ email: '  NEW.Name@Example.COM ', currentPassword: OLD_PASSWORD });
    expect(res.status).toBe(200);
    expect(adminRepository.updateProfile).toHaveBeenCalledWith(CONNECTION, 7, { email: 'new.name@example.com' });
  });

  test('email and display name together are audited as two field names', async () => {
    const res = await patchProfile({ displayName: 'Sam', email: 'new@example.com', currentPassword: OLD_PASSWORD });
    expect(res.status).toBe(200);
    expect(auditEvents).toHaveLength(1);
    expect([...auditEvents[0].details.changedFields].sort()).toEqual(['displayName', 'email']);
    expect(adminRepository.updateProfile).toHaveBeenCalledWith(CONNECTION, 7, { displayName: 'Sam', email: 'new@example.com' });
  });

  test('a wrong password also stops a display-name change that came with the email change', async () => {
    const res = await patchProfile({ displayName: 'Sam', email: 'new@example.com', currentPassword: 'wrong' });
    expect(res.status).toBe(403);
    expect(row.display_name).toBeNull();
    expect(adminRepository.updateProfile).not.toHaveBeenCalled();
  });

  test('the same email (even written differently) is not a change: no password is needed and nothing is written', async () => {
    const res = await patchProfile({ email: '  ADMIN@Example.com ' });
    expect(res.status).toBe(200);
    expect(adminRepository.updateProfile).not.toHaveBeenCalled();
    expect(auditRepository.insert).not.toHaveBeenCalled();
  });

  test('another account already uses the email: 409 naming the email field, rolled back, nothing audited', async () => {
    adminRepository.updateProfile.mockRejectedValue(
      Object.assign(new Error('Duplicate entry for key admins.uq_admins_email'), { code: 'ER_DUP_ENTRY', sqlMessage: "Duplicate entry 'x' for key 'admins.uq_admins_email'" })
    );
    const res = await patchProfile({ email: 'taken@example.com', currentPassword: OLD_PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Another account already uses this email', fields: ['email'] });
    expect(auditRepository.insert).not.toHaveBeenCalled();
    expect(events.at(-1)).toBe('rollback');
    expect(JSON.stringify(res.body)).not.toMatch(/Duplicate entry|uq_admins|sql/i);
  });

  test('a duplicate on some other key is a generic 500, not reported as an email conflict', async () => {
    adminRepository.updateProfile.mockRejectedValue(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY', sqlMessage: "Duplicate entry '1' for key 'admins.PRIMARY'" }));
    const res = await patchProfile({ email: 'new@example.com', currentPassword: OLD_PASSWORD });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  test('the wrong password is checked before the duplicate email, so a wrong password reveals nothing about other accounts', async () => {
    adminRepository.updateProfile.mockRejectedValue(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY', sqlMessage: "Duplicate entry 'x' for key 'admins.uq_admins_email'" }));
    const res = await patchProfile({ email: 'taken@example.com', currentPassword: 'wrong' });
    expect(res.status).toBe(403);
    expect(adminRepository.updateProfile).not.toHaveBeenCalled();
  });

  test('if the audit write fails the whole change is rolled back and the answer is a generic 500', async () => {
    auditRepository.insert.mockRejectedValue(new Error('audit down'));
    const res = await patchProfile({ email: 'new@example.com', currentPassword: OLD_PASSWORD });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(row.email).toBe(EMAIL); // put back by the rollback
    expect(events.at(-1)).toBe('rollback');
  });
});

describe('PATCH /api/account/profile: validation, authentication, scope', () => {
  test.each([
    ['an empty body', {}, ['body']],
    ['only the password', { currentPassword: 'x' }, ['body']],
    ['a bad email', { email: 'nope' }, ['email']],
    ['an email that is too long', { email: `${'a'.repeat(250)}@example.com` }, ['email']],
    ['a password over 72 bytes', { email: 'new@example.com', currentPassword: 'x'.repeat(73) }, ['currentPassword']],
    ['an empty current password', { email: 'new@example.com', currentPassword: '' }, ['currentPassword']],
    ['a numeric current password', { email: 'new@example.com', currentPassword: 12345 }, ['currentPassword']],
  ])('400 for %s, and nothing is touched', async (_label, body, fields) => {
    const res = await patchProfile(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', fields });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test.each(['id', 'isActive', 'is_active', 'passwordHash', 'password_hash', 'tokenVersion', 'token_version', 'createdAt', 'role'])(
    'a supplied "%s" property is rejected and named',
    async (key) => {
      const res = await patchProfile({ displayName: 'Sam', [key]: key === 'id' ? 8 : 'x' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request', fields: [key] });
      expect(db.withTransaction).not.toHaveBeenCalled();
    }
  );

  test('401 without a session, with an old session version, and the database is not touched', async () => {
    expect((await patchProfile({ displayName: 'Sam' }, { withCookie: false })).status).toBe(401);
    row.token_version = 1;
    expect((await patchProfile({ displayName: 'Sam' }, { tv: 0 })).status).toBe(401);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('only ever changes the signed-in account: the id comes from the session, never from the request', async () => {
    const res = await request(app).patch('/api/account/profile?id=8').set('Cookie', cookie()).send({ displayName: 'Sam' });
    expect(res.status).toBe(200);
    expect(adminRepository.findForUpdate).toHaveBeenCalledWith(CONNECTION, 7);
    expect(adminRepository.updateProfile).toHaveBeenCalledWith(CONNECTION, 7, { displayName: 'Sam' });
  });

  test('403 from another origin', async () => {
    const res = await request(app).patch('/api/account/profile').set('Cookie', cookie()).set('Origin', 'http://evil.example').send({ displayName: 'Sam' });
    expect(res.status).toBe(403);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('an account that was deactivated in between ends the session (401)', async () => {
    adminRepository.findForUpdate.mockImplementation(async () => ({ ...row, is_active: 0 }));
    const res = await patchProfile({ displayName: 'Sam' });
    expect(res.status).toBe(401);
    expect(adminRepository.updateProfile).not.toHaveBeenCalled();
  });
});

describe('POST /api/account/password', () => {
  test('changes the password, raises the session version, writes the audit record and commits, all in one transaction', async () => {
    const res = await postPassword({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Password changed. Other sessions have been signed out.' });
    expect(res.headers['cache-control']).toBe('no-store');
    // one transaction: lock, ONE write that changes hash and version together, audit, read back, commit
    expect(events).toEqual(['begin', 'lock', 'write:password+version', 'audit:ACCOUNT_PASSWORD_CHANGED', 'lock', 'commit']);
    expect(adminRepository.updatePasswordAndBumpVersion).toHaveBeenCalledTimes(1);
    expect(row.token_version).toBe(1);
  });

  test('stores a fresh bcrypt hash (cost 12) of the new password, never the password', async () => {
    await postPassword({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    const hash = adminRepository.updatePasswordAndBumpVersion.mock.calls[0][2];
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(hash).not.toContain(NEW_PASSWORD);
    expect(hash).not.toBe(oldHash);
    expect(await bcrypt.compare(NEW_PASSWORD, hash)).toBe(true);
    expect(await bcrypt.compare(OLD_PASSWORD, hash)).toBe(false);
  });

  test('issues a fresh login cookie carrying the NEW session version, with the usual cookie settings', async () => {
    const res = await postPassword({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    const header = cookieFrom(res);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\//);
    expect(header).toMatch(/Max-Age=3600/);
    const decoded = jwt.decode(tokenFrom(res));
    expect(decoded.sub).toBe('7');
    expect(decoded.tv).toBe(1);
  });

  test('the new cookie works and the old session is refused at once (the old cookie, and a legacy cookie without tv)', async () => {
    const legacy = await get('/api/auth/me', { tv: undefined });
    expect(legacy.status).toBe(200); // before the change, a token without tv works (version 0)
    const res = await postPassword({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    const fresh = await request(app).get('/api/account').set('Cookie', `admin_token=${tokenFrom(res)}`);
    expect(fresh.status).toBe(200);
    expect((await get('/api/account', { tv: 0 })).status).toBe(401);
    expect((await get('/api/account', { tv: undefined })).status).toBe(401);
    expect((await get('/api/auth/me', { tv: 0 })).status).toBe(401);
  });

  test('the old password stops working and the new one works for login', async () => {
    adminRepository.findByEmail.mockImplementation(async (email) => (email === row.email ? { ...row } : null));
    await postPassword({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(await authService.verifyCredentials(EMAIL, OLD_PASSWORD)).toBeNull();
    expect(await authService.verifyCredentials(EMAIL, NEW_PASSWORD)).toEqual({ id: 7, email: EMAIL, tokenVersion: 1 });
  });

  test('audits the change with NO details: not the password, not a hash, not a token', async () => {
    await postPassword({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(auditEvents).toEqual([{ adminId: 7, eventType: 'ACCOUNT_PASSWORD_CHANGED', entityType: 'ACCOUNT', entityId: 7, details: null }]);
  });

  test('neither the response nor the audit record nor the cookie value contains a password or a hash', async () => {
    const res = await postPassword({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    const everything = JSON.stringify([res.body, auditEvents]) + tokenFrom(res);
    for (const secret of [OLD_PASSWORD, NEW_PASSWORD, row.password_hash, oldHash]) expect(everything).not.toContain(secret);
    expect(everything).not.toMatch(/\$2[aby]\$/);
  });

  test('a wrong current password is 403: nothing changes, nothing is audited, no cookie is issued', async () => {
    const res = await postPassword({ currentPassword: 'definitely-wrong', newPassword: NEW_PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Current password is incorrect', fields: ['currentPassword'] });
    expect(adminRepository.updatePasswordAndBumpVersion).not.toHaveBeenCalled();
    expect(auditRepository.insert).not.toHaveBeenCalled();
    expect(cookieFrom(res)).toBeUndefined();
    expect(row.token_version).toBe(0);
    expect(row.password_hash).toBe(oldHash);
  });

  test('if the audit write fails, the password and the version are rolled back together and no cookie is issued', async () => {
    auditRepository.insert.mockRejectedValue(new Error('audit down'));
    const res = await postPassword({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(cookieFrom(res)).toBeUndefined();
    expect(row.password_hash).toBe(oldHash);
    expect(row.token_version).toBe(0);
    expect(events.at(-1)).toBe('rollback');
    expect((await get('/api/account', { tv: 0 })).status).toBe(200); // the old session still works: nothing changed
  });

  test('if the update itself fails, nothing is audited and no cookie is issued', async () => {
    adminRepository.updatePasswordAndBumpVersion.mockRejectedValue(new Error('update failed'));
    const res = await postPassword({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(500);
    expect(auditRepository.insert).not.toHaveBeenCalled();
    expect(cookieFrom(res)).toBeUndefined();
  });

  test.each([
    ['a new password under 12 characters', { currentPassword: OLD_PASSWORD, newPassword: 'short-pass1' }, ['newPassword']],
    ['a new password over 72 bytes', { currentPassword: OLD_PASSWORD, newPassword: 'x'.repeat(73) }, ['newPassword']],
    ['a new password equal to the current one', { currentPassword: OLD_PASSWORD, newPassword: OLD_PASSWORD }, ['newPassword']],
    ['a missing current password', { newPassword: NEW_PASSWORD }, ['currentPassword']],
    ['a missing new password', { currentPassword: OLD_PASSWORD }, ['newPassword']],
    ['an empty current password', { currentPassword: '', newPassword: NEW_PASSWORD }, ['currentPassword']],
    ['a current password over 72 bytes', { currentPassword: 'x'.repeat(73), newPassword: NEW_PASSWORD }, ['currentPassword']],
    ['numbers instead of text', { currentPassword: 1, newPassword: 2 }, ['currentPassword', 'newPassword']],
    ['an empty body', {}, ['currentPassword', 'newPassword']],
  ])('400 for %s, and the database is not touched', async (_label, body, fields) => {
    const res = await postPassword(body);
    expect(res.status).toBe(400);
    expect([...res.body.fields].sort()).toEqual([...fields].sort());
    expect(db.withTransaction).not.toHaveBeenCalled();
    expect(cookieFrom(res)).toBeUndefined();
  });

  test('a password of exactly 12 characters and one of exactly 72 bytes are accepted', async () => {
    expect((await postPassword({ currentPassword: OLD_PASSWORD, newPassword: 'abcdefghij12' })).status).toBe(200);
    row.token_version = 0;
    row.password_hash = oldHash;
    expect((await postPassword({ currentPassword: OLD_PASSWORD, newPassword: 'x'.repeat(72) })).status).toBe(200);
  });

  test.each(['id', 'email', 'tokenVersion', 'token_version', 'passwordHash', 'adminId'])('a supplied "%s" property is rejected', async (key) => {
    const res = await postPassword({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD, [key]: 1 });
    expect(res.status).toBe(400);
    expect(res.body.fields).toContain(key);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('401 without a session or with an old session version; 403 from another origin', async () => {
    expect((await postPassword({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }, { withCookie: false })).status).toBe(401);
    row.token_version = 1;
    expect((await postPassword({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }, { tv: 0 })).status).toBe(401);
    const cross = await request(app).post('/api/account/password').set('Cookie', cookie(1)).set('Sec-Fetch-Site', 'cross-site').send({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(cross.status).toBe(403);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('a second change with the OLD password fails after the first succeeded (the row is locked, so they run one after the other)', async () => {
    expect((await postPassword({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(200);
    const again = await postPassword({ currentPassword: OLD_PASSWORD, newPassword: `${NEW_PASSWORD}2` }, { tv: 1 });
    expect(again.status).toBe(403);
    expect(row.token_version).toBe(1);
  });

  test('two changes in a row with the right passwords raise the version twice', async () => {
    const first = await postPassword({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    const second = await request(app).post('/api/account/password').set('Cookie', `admin_token=${tokenFrom(first)}`).send({ currentPassword: NEW_PASSWORD, newPassword: `${NEW_PASSWORD}-again` });
    expect(second.status).toBe(200);
    expect(jwt.decode(tokenFrom(second)).tv).toBe(2);
    expect(row.token_version).toBe(2);
  });
});

describe('the password-change rate limiter', () => {
  function miniApp(limit) {
    const mini = express();
    mini.use(cookieParser());
    mini.use(express.json());
    mini.use('/api/account', createAccountRouter({ passwordLimiter: createPasswordChangeLimiter({ limit }) }));
    mini.use(errorHandler);
    return mini;
  }
  const send = (mini, body, path = '/api/account/password', method = 'post') => request(mini)[method](path).set('Cookie', cookie()).send(body);

  test('blocks an administrator after too many WRONG current passwords, even with the right password afterwards', async () => {
    const mini = miniApp(3);
    for (let i = 0; i < 3; i += 1) {
      expect((await send(mini, { currentPassword: 'wrong-password', newPassword: NEW_PASSWORD })).status).toBe(403);
    }
    const blocked = await send(mini, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/too many/i);
    expect(adminRepository.updatePasswordAndBumpVersion).not.toHaveBeenCalled();
  });

  test('is shared with the email change: wrong passwords there use the same allowance', async () => {
    const mini = miniApp(2);
    expect((await send(mini, { email: 'a@example.com', currentPassword: 'wrong' }, '/api/account/profile', 'patch')).status).toBe(403);
    expect((await send(mini, { currentPassword: 'wrong', newPassword: NEW_PASSWORD })).status).toBe(403);
    expect((await send(mini, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(429);
    expect((await send(mini, { email: 'a@example.com', currentPassword: OLD_PASSWORD }, '/api/account/profile', 'patch')).status).toBe(429);
  });

  test('successful changes, validation mistakes and a missing password do not use up the allowance', async () => {
    const mini = miniApp(2);
    for (let i = 0; i < 4; i += 1) {
      expect((await send(mini, { displayName: `Name ${i}` }, '/api/account/profile', 'patch')).status).toBe(200);
    }
    for (let i = 0; i < 4; i += 1) {
      expect((await send(mini, { newPassword: 'x' })).status).toBe(400);
      expect((await send(mini, { email: 'b@example.com' }, '/api/account/profile', 'patch')).status).toBe(400); // password missing
    }
    // the allowance is still whole: two wrong passwords are allowed before the block
    expect((await send(mini, { currentPassword: 'wrong', newPassword: NEW_PASSWORD })).status).toBe(403);
    expect((await send(mini, { currentPassword: 'wrong', newPassword: NEW_PASSWORD })).status).toBe(403);
    expect((await send(mini, { currentPassword: 'wrong', newPassword: NEW_PASSWORD })).status).toBe(429);
  });

  test('is counted per administrator, not for everybody', () => {
    const mini = express();
    mini.use((req, res, next) => {
      req.admin = { id: Number(req.get('x-admin')) };
      next();
    });
    mini.post('/x', createPasswordChangeLimiter({ limit: 1 }), (req, res) => res.status(403).json({ error: 'wrong' }));
    return request(mini)
      .post('/x').set('x-admin', '1').send({})
      .then(async (first) => {
        expect(first.status).toBe(403);
        expect((await request(mini).post('/x').set('x-admin', '1').send({})).status).toBe(429);
        expect((await request(mini).post('/x').set('x-admin', '2').send({})).status).toBe(403); // a different admin is not blocked
      });
  });

});

describe('the password-attempt limiter runs only when the current password will be checked', () => {
  const accountService = require('../../src/services/accountService');

  // A limiter that only records whether it was reached.
  function spyApp() {
    const reached = jest.fn((req, res, next) => next());
    const mini = express();
    mini.use(cookieParser());
    mini.use(express.json());
    mini.use('/api/account', createAccountRouter({ passwordLimiter: reached }));
    mini.use(errorHandler);
    return { mini, reached };
  }
  const send = (mini, body, path = '/api/account/profile', method = 'patch') => request(mini)[method](path).set('Cookie', cookie()).send(body);

  test('a display-name-only change never reaches the limiter', async () => {
    const { mini, reached } = spyApp();
    expect((await send(mini, { displayName: 'Sam' })).status).toBe(200);
    expect((await send(mini, { displayName: null })).status).toBe(200);
    expect((await send(mini, { displayName: 'Sam', currentPassword: 'an-unneeded-password' })).status).toBe(200); // nothing is verified
    expect(reached).not.toHaveBeenCalled();
  });

  test('an email change to a different address reaches the limiter, whether the password is right, wrong or missing', async () => {
    const { mini, reached } = spyApp();
    expect((await send(mini, { email: 'new@example.com', currentPassword: OLD_PASSWORD })).status).toBe(200);
    expect(reached).toHaveBeenCalledTimes(1);
    expect((await send(mini, { email: 'other@example.com', currentPassword: 'wrong-password' })).status).toBe(403);
    expect(reached).toHaveBeenCalledTimes(2);
    expect((await send(mini, { email: 'third@example.com' })).status).toBe(400);
    expect(reached).toHaveBeenCalledTimes(3);
  });

  test('an email change that comes with a display name still reaches the limiter', async () => {
    const { mini, reached } = spyApp();
    await send(mini, { displayName: 'Sam', email: 'new@example.com', currentPassword: OLD_PASSWORD });
    expect(reached).toHaveBeenCalledTimes(1);
  });

  test('"changing" the email to the address already in use asks for no password, so it does not reach the limiter', async () => {
    const { mini, reached } = spyApp();
    expect((await send(mini, { email: EMAIL })).status).toBe(200);
    expect((await send(mini, { email: '  ADMIN@Example.COM ' })).status).toBe(200);
    expect(reached).not.toHaveBeenCalled();
    expect(adminRepository.updateProfile).not.toHaveBeenCalled();
  });

  test('a body that fails validation never reaches the limiter and gets its usual 400', async () => {
    const { mini, reached } = spyApp();
    for (const body of [{}, { currentPassword: 'x' }, { email: 'not-an-email' }, { displayName: 'Sam', isActive: false }, { email: 'a@example.com', currentPassword: '' }]) {
      expect((await send(mini, body)).status).toBe(400);
    }
    expect(reached).not.toHaveBeenCalled();
  });

  test('the password-change route always goes through the limiter', async () => {
    const { mini, reached } = spyApp();
    // (the wrong password first: a successful change raises the session version, which would end this test's cookie)
    expect((await send(mini, { currentPassword: 'wrong-password', newPassword: NEW_PASSWORD }, '/api/account/password', 'post')).status).toBe(403);
    expect((await send(mini, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }, '/api/account/password', 'post')).status).toBe(200);
    expect(reached).toHaveBeenCalledTimes(2);
  });

  test('requiresCurrentPassword is true only for an email that differs from the stored one', () => {
    const needs = accountService.requiresCurrentPassword;
    expect(needs({ email: 'new@example.com' }, 'admin@example.com')).toBe(true);
    expect(needs({ email: 'new@example.com', displayName: 'Sam' }, 'admin@example.com')).toBe(true);
    expect(needs({ email: 'admin@example.com' }, 'admin@example.com')).toBe(false);
    expect(needs({ displayName: 'Sam' }, 'admin@example.com')).toBe(false);
    expect(needs({ displayName: null }, 'admin@example.com')).toBe(false);
    expect(needs({}, 'admin@example.com')).toBe(false);
    expect(needs({ email: undefined }, 'admin@example.com')).toBe(false);
  });

  test('the service uses the same rule: an email change without the password is refused, a display-name change is not', async () => {
    await expect(accountService.updateProfile(7, { email: 'new@example.com' })).rejects.toBeInstanceOf(accountService.CurrentPasswordRequiredError);
    await expect(accountService.updateProfile(7, { displayName: 'Sam' })).resolves.toMatchObject({ displayName: 'Sam' });
  });
});

describe('display-name edits are neither counted nor blocked by the password-attempt limiter, and the protection stays', () => {
  function realLimiterApp(limit) {
    const mini = express();
    mini.use(cookieParser());
    mini.use(express.json());
    mini.use('/api/account', createAccountRouter({ passwordLimiter: createPasswordChangeLimiter({ limit }) }));
    mini.use(errorHandler);
    return mini;
  }
  const send = (mini, body, path = '/api/account/profile', method = 'patch') => request(mini)[method](path).set('Cookie', cookie()).send(body);
  const wrongEmailChange = (mini) => send(mini, { email: 'guess@example.com', currentPassword: 'wrong-password' });

  test('many display-name changes use up none of the allowance for wrong passwords', async () => {
    const mini = realLimiterApp(2);
    for (let i = 0; i < 10; i += 1) {
      expect((await send(mini, { displayName: `Name ${i}` })).status).toBe(200);
    }
    expect((await wrongEmailChange(mini)).status).toBe(403);
    expect((await wrongEmailChange(mini)).status).toBe(403);
    expect((await wrongEmailChange(mini)).status).toBe(429); // exactly the allowance of 2 wrong passwords, as before
  });

  test('once the allowance is used up, display-name changes and same-address "changes" still work', async () => {
    const mini = realLimiterApp(2);
    expect((await wrongEmailChange(mini)).status).toBe(403);
    expect((await wrongEmailChange(mini)).status).toBe(403);
    expect((await wrongEmailChange(mini)).status).toBe(429);

    expect((await send(mini, { displayName: 'Still allowed' })).status).toBe(200);
    expect((await send(mini, { displayName: null })).status).toBe(200);
    expect((await send(mini, { email: EMAIL })).status).toBe(200);
    expect(row.display_name).toBeNull();
  });

  test('once the allowance is used up, the protection holds: an email change (even with the right password) and a password change are blocked', async () => {
    const mini = realLimiterApp(2);
    await wrongEmailChange(mini);
    await wrongEmailChange(mini);
    expect((await send(mini, { email: 'new@example.com', currentPassword: OLD_PASSWORD })).status).toBe(429);
    expect((await send(mini, { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }, '/api/account/password', 'post')).status).toBe(429);
    expect(row.email).toBe(EMAIL);
    expect(row.token_version).toBe(0);
    expect(adminRepository.updatePasswordAndBumpVersion).not.toHaveBeenCalled();
  });

  test('wrong passwords on the password-change route and on the email change share one allowance', async () => {
    const mini = realLimiterApp(2);
    expect((await send(mini, { currentPassword: 'wrong-password', newPassword: NEW_PASSWORD }, '/api/account/password', 'post')).status).toBe(403);
    expect((await wrongEmailChange(mini)).status).toBe(403);
    expect((await send(mini, { currentPassword: 'wrong-password', newPassword: NEW_PASSWORD }, '/api/account/password', 'post')).status).toBe(429);
    expect((await wrongEmailChange(mini)).status).toBe(429);
  });

  test('interleaving display-name changes with wrong passwords does not let extra guesses through', async () => {
    const mini = realLimiterApp(2);
    expect((await wrongEmailChange(mini)).status).toBe(403);
    expect((await send(mini, { displayName: 'A' })).status).toBe(200);
    expect((await wrongEmailChange(mini)).status).toBe(403);
    expect((await send(mini, { displayName: 'B' })).status).toBe(200);
    expect((await wrongEmailChange(mini)).status).toBe(429);
    expect((await send(mini, { displayName: 'C' })).status).toBe(200);
    expect((await wrongEmailChange(mini)).status).toBe(429);
  });

  test('a wrong password is still never accepted and nothing is written for it', async () => {
    const mini = realLimiterApp(5);
    const res = await wrongEmailChange(mini);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Current password is incorrect', fields: ['currentPassword'] });
    expect(adminRepository.updateProfile).not.toHaveBeenCalled();
    expect(auditRepository.insert).not.toHaveBeenCalled();
  });

  test('a validation mistake on an email change is not counted as a password guess', async () => {
    const mini = realLimiterApp(2);
    for (let i = 0; i < 5; i += 1) {
      expect((await send(mini, { email: 'new@example.com' })).status).toBe(400); // password missing
      expect((await send(mini, { email: 'not-an-email', currentPassword: 'x' })).status).toBe(400);
    }
    expect((await wrongEmailChange(mini)).status).toBe(403);
    expect((await wrongEmailChange(mini)).status).toBe(403);
    expect((await wrongEmailChange(mini)).status).toBe(429);
  });
});
