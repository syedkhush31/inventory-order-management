// The signed-in administrator's own account against the real MySQL TEST database (inventory_test): the profile, the
// password change, the session version (token_version) that ends other sessions, and the wrong-password limiter.
// This file WRITES to the test database: every test starts from empty tables (resetTestDatabase) and the tables are
// emptied again afterwards. See tests/helpers/integrationEnv.js for the guards that refuse to run against anything but
// inventory_test.
//
// Passwords here are random per run and never written to a file. The administrator of every test is created with a
// known random password (ctx.password) so that "current password" checks work against the real bcrypt hash.
const crypto = require('crypto');
const { INTEGRATION_TIMEOUT, useIntegrationDatabase } = require('../helpers/integrationEnv');
const f = require('../helpers/factories');
const db = require('../helpers/dbAssert');
const { client, cookieFor, cookieFromResponse, loginCookie } = require('../helpers/http');
const { freshApp } = require('../helpers/freshApp');
const { assertNoSecrets } = require('../helpers/privacy');

jest.setTimeout(INTEGRATION_TIMEOUT);

const ctx = useIntegrationDatabase();

const newPassword = () => crypto.randomBytes(12).toString('hex'); // 24 characters, above the 12-character minimum
const profile = (body) => ctx.api.patch('/api/account/profile', body);
const changePassword = (api, body) => api.post('/api/account/password', body);

// Everything about the administrator that must not change when a request is refused. The password hash is replaced by a
// SHA-256 fingerprint of itself, so a failing comparison can never print the hash.
async function snapshot() {
  const row = await db.adminRow(ctx.admin.id);
  const fingerprint = crypto.createHash('sha256').update(row.passwordHash).digest('hex');
  return { ...row, passwordHash: fingerprint, auditRows: await db.countRows('audit_log') };
}

// ------------------------------------------------------------------------------------------------------ profile
describe('ACC-1: reading the account', () => {
  test('ACC-1 returns only id, email, display name and creation date', async () => {
    const res = await ctx.api.get('/api/account');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      account: { id: ctx.admin.id, email: ctx.admin.email, displayName: null, createdAt: expect.any(String) },
    });
    assertNoSecrets(res.body);
  });
});

describe('ACC-2: the display name', () => {
  test('ACC-2 can be set (trimmed), cleared with "" and with null, and each real change is audited by field name', async () => {
    const set = await profile({ displayName: '  Sam Display  ' });
    expect(set.status).toBe(200);
    expect(set.body.account.displayName).toBe('Sam Display');
    expect((await db.adminRow(ctx.admin.id)).displayName).toBe('Sam Display');

    const cleared = await profile({ displayName: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.account.displayName).toBeNull();

    const clearedAgain = await profile({ displayName: null }); // already empty: nothing changes
    expect(clearedAgain.status).toBe(200);

    const rows = await db.auditRows();
    expect(rows.map((row) => [row.eventType, row.entityType, row.entityId, row.details])).toEqual([
      ['ACCOUNT_PROFILE_UPDATED', 'ACCOUNT', ctx.admin.id, { changedFields: ['displayName'] }],
      ['ACCOUNT_PROFILE_UPDATED', 'ACCOUNT', ctx.admin.id, { changedFields: ['displayName'] }],
    ]);
    // The new name itself is never copied into the audit log.
    expect(JSON.stringify(rows)).not.toContain('Sam Display');
  });

  test('ACC-2 a name of 101 characters or with a control character is refused', async () => {
    for (const displayName of ['x'.repeat(101), 'bad\u0007name']) {
      const res = await profile({ displayName });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'Invalid request', fields: ['displayName'] });
    }
    expect((await db.adminRow(ctx.admin.id)).displayName).toBeNull();
    expect(await db.countRows('audit_log')).toBe(0);
  });
});

describe('ACC-3 / ACC-4: changing the email address', () => {
  test('ACC-3 needs the current password: missing is 400, wrong is 403, right is 200 and the address is lower-cased', async () => {
    const before = await snapshot();

    const missing = await profile({ email: 'new.admin@example.test' });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ error: 'Invalid request', fields: ['currentPassword'] });

    const wrong = await profile({ email: 'new.admin@example.test', currentPassword: 'definitely-the-wrong-password' });
    expect(wrong.status).toBe(403);
    expect(wrong.body).toEqual({ error: 'Current password is incorrect', fields: ['currentPassword'] });
    expect(await snapshot()).toEqual(before); // nothing changed, nothing audited

    const ok = await profile({ email: 'New.Admin@Example.TEST', currentPassword: ctx.password });
    expect(ok.status).toBe(200);
    expect(ok.body.account.email).toBe('new.admin@example.test');
    expect((await db.adminRow(ctx.admin.id)).email).toBe('new.admin@example.test');
    expect((await db.auditRows()).map((row) => row.details)).toEqual([{ changedFields: ['email'] }]);
  });

  test('ACC-3 an invalid address is refused', async () => {
    const res = await profile({ email: 'not-an-email', currentPassword: ctx.password });

    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(['email']);
    expect((await db.adminRow(ctx.admin.id)).email).toBe(ctx.admin.email);
  });

  test('ACC-4 an address another account already uses is a 409 and nothing changes', async () => {
    await f.createAdmin({ email: 'taken@example.test', passwordHash: ctx.passwordHash });
    const before = await snapshot();

    for (const email of ['taken@example.test', 'TAKEN@Example.Test']) {
      const res = await profile({ email, currentPassword: ctx.password });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'Another account already uses this email', fields: ['email'] });
    }
    expect(await snapshot()).toEqual(before);
  });
});

describe('ACC-5 / ACC-6: edits that change nothing, and edits that are not allowed', () => {
  test('ACC-5 a request that changes nothing answers 200 and writes and audits nothing', async () => {
    const before = await snapshot();

    expect((await profile({ displayName: null })).status).toBe(200); // already empty
    // Same address (any letter case): no password is needed because nothing changes.
    expect((await profile({ email: ctx.admin.email })).status).toBe(200);
    expect((await profile({ email: ctx.admin.email.toUpperCase() })).status).toBe(200);

    expect(await snapshot()).toEqual(before);
  });

  test.each([
    ['an id', { id: 999, displayName: 'X' }],
    ['isActive', { isActive: false }],
    ['tokenVersion', { tokenVersion: 5 }],
    ['passwordHash', { passwordHash: 'x' }],
    ['an unknown property next to a valid one', { displayName: 'X', role: 'admin' }],
    ['no fields at all', {}],
  ])('ACC-6 rejects %s with 400 and changes nothing', async (_name, body) => {
    const before = await snapshot();

    const res = await profile(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
    expect(await snapshot()).toEqual(before);
  });
});

describe('ACC-7: a profile change does not end sessions', () => {
  test('ACC-7 changing the email leaves the session version and other sessions alone', async () => {
    const otherSession = await loginCookie(ctx.app, ctx.admin.email, ctx.password);
    expect(otherSession).not.toBeNull();

    const res = await profile({ email: 'renamed.admin@example.test', currentPassword: ctx.password });
    expect(res.status).toBe(200);

    expect((await db.adminRow(ctx.admin.id)).tokenVersion).toBe(0);
    for (const cookie of [ctx.cookie, otherSession]) {
      const me = await client(ctx.app, cookie).get('/api/auth/me');
      expect(me.status).toBe(200);
      expect(Number(me.body.admin.id)).toBe(ctx.admin.id);
      expect(me.body.admin.email).toBe('renamed.admin@example.test');
    }
  });
});

// ----------------------------------------------------------------------------------------------- password change
describe('PWD-1 to PWD-3: a successful password change', () => {
  test('PWD-1 changes the hash, raises the session version by one, issues a new cookie and audits it without details', async () => {
    const before = await db.adminRow(ctx.admin.id);
    const password = newPassword();

    const res = await changePassword(ctx.api, { currentPassword: ctx.password, newPassword: password });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Password changed. Other sessions have been signed out.' });
    expect(cookieFromResponse(res)).toMatch(/^admin_token=.+/);
    const after = await db.adminRow(ctx.admin.id);
    expect(after.passwordHash !== before.passwordHash).toBe(true);
    expect(after.tokenVersion).toBe(before.tokenVersion + 1);
    expect((await db.auditRows()).map(({ id, ...rest }) => rest)).toEqual([
      {
        adminId: ctx.admin.id,
        eventType: 'ACCOUNT_PASSWORD_CHANGED',
        entityType: 'ACCOUNT',
        entityId: ctx.admin.id,
        details: null,
      },
    ]);
    assertNoSecrets(res.body, [ctx.password, password]);
  });

  test('PWD-2 afterwards the old password is refused and the new one signs in', async () => {
    const password = newPassword();
    expect((await changePassword(ctx.api, { currentPassword: ctx.password, newPassword: password })).status).toBe(200);

    expect(await loginCookie(ctx.app, ctx.admin.email, ctx.password)).toBeNull();
    expect(await loginCookie(ctx.app, ctx.admin.email, password)).toMatch(/^admin_token=/);
  });

  test('PWD-3 every earlier session stops working, and only the new cookie from the change works', async () => {
    const sessionX = await loginCookie(ctx.app, ctx.admin.email, ctx.password);
    const sessionY = await loginCookie(ctx.app, ctx.admin.email, ctx.password);
    expect(sessionX).not.toBeNull();
    expect(sessionY).not.toBeNull();
    // Before the change all three cookies (two sign-ins and the one minted by the test) are valid.
    for (const cookie of [sessionX, sessionY, ctx.cookie]) {
      expect((await client(ctx.app, cookie).get('/api/auth/me')).status).toBe(200);
    }

    const changed = await changePassword(client(ctx.app, sessionX), { currentPassword: ctx.password, newPassword: newPassword() });
    expect(changed.status).toBe(200);
    const fresh = cookieFromResponse(changed);

    for (const cookie of [sessionX, sessionY, ctx.cookie]) {
      const me = await client(ctx.app, cookie).get('/api/auth/me');
      expect(me.status).toBe(401);
      const data = await client(ctx.app, cookie).get('/api/settings');
      expect(data.status).toBe(401);
    }
    expect((await client(ctx.app, fresh).get('/api/auth/me')).status).toBe(200);
    expect((await client(ctx.app, fresh).get('/api/settings')).status).toBe(200);
  });
});

describe('PWD-4: refused password changes', () => {
  test('PWD-4 every refusal leaves the hash, the session version and the audit log untouched', async () => {
    const good = newPassword();
    const cases = [
      ['a wrong current password', { currentPassword: 'definitely-the-wrong-password', newPassword: good }, 403, ['currentPassword']],
      ['a new password under 12 characters', { currentPassword: ctx.password, newPassword: 'short-1' }, 400, ['newPassword']],
      ['a new password equal to the current one', { currentPassword: ctx.password, newPassword: ctx.password }, 400, ['newPassword']],
      ['a new password over 72 bytes', { currentPassword: ctx.password, newPassword: 'x'.repeat(80) }, 400, ['newPassword']],
      ['a current password over 72 bytes', { currentPassword: 'x'.repeat(80), newPassword: good }, 400, ['currentPassword']],
      ['no current password', { newPassword: good }, 400, ['currentPassword']],
      ['no new password', { currentPassword: ctx.password }, 400, ['newPassword']],
      ['an unknown property', { currentPassword: ctx.password, newPassword: good, role: 'admin' }, 400, ['role']],
    ];

    for (const [name, body, status, fields] of cases) {
      const before = await snapshot();
      const res = await changePassword(ctx.api, body);
      expect([name, res.status]).toEqual([name, status]);
      expect([name, res.body.fields]).toEqual([name, fields]);
      expect([name, await snapshot()]).toEqual([name, before]);
    }
    // The administrator can still use the original password and the original cookie.
    expect((await client(ctx.app, ctx.cookie).get('/api/auth/me')).status).toBe(200);
  });
});

// ------------------------------------------------------------------------------------------------- the limiter
describe('PWD-5 / PWD-6: the wrong-password limiter', () => {
  test('PWD-5 five wrong answers are allowed, the sixth request is blocked even with the right password, others are not affected', async () => {
    const fresh = await freshApp(); // its own limiter counters
    try {
      const other = await f.createAdmin({ passwordHash: ctx.passwordHash });
      const api = client(fresh.app, ctx.cookie);
      const wrong = { currentPassword: 'definitely-the-wrong-password', newPassword: newPassword() };

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        expect([attempt, (await changePassword(api, wrong)).status]).toEqual([attempt, 403]);
      }
      const blocked = await changePassword(api, wrong);
      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual({ error: 'Too many incorrect password attempts. Please try again later.' });

      const rightButBlocked = await changePassword(api, { currentPassword: ctx.password, newPassword: newPassword() });
      expect(rightButBlocked.status).toBe(429);
      expect((await db.adminRow(ctx.admin.id)).tokenVersion).toBe(0); // the blocked request did not change anything

      // The allowance is per administrator.
      const otherApi = client(fresh.app, cookieFor(other));
      expect((await changePassword(otherApi, wrong)).status).toBe(403);
    } finally {
      await fresh.close();
    }
  });

  test('PWD-6 only a wrong current password uses up the allowance: validation errors and duplicate emails do not', async () => {
    const fresh = await freshApp();
    try {
      await f.createAdmin({ email: 'taken@example.test', passwordHash: ctx.passwordHash });
      const api = client(fresh.app, ctx.cookie);

      for (let i = 0; i < 6; i += 1) {
        const res = await changePassword(api, { currentPassword: ctx.password, newPassword: 'short-1' }); // 400
        expect(res.status).toBe(400);
      }
      for (let i = 0; i < 3; i += 1) {
        const res = await api.patch('/api/account/profile', { email: 'taken@example.test', currentPassword: ctx.password }); // 409
        expect(res.status).toBe(409);
      }
      // Nine requests so far, none a wrong password: all five wrong answers are still allowed.
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const res = await changePassword(api, { currentPassword: 'definitely-the-wrong-password', newPassword: newPassword() });
        expect([attempt, res.status]).toEqual([attempt, 403]);
      }
      const blocked = await api.patch('/api/account/profile', { email: 'another@example.test', currentPassword: ctx.password });
      expect(blocked.status).toBe(429); // the profile route shares the allowance when the email changes
      // A display-name-only edit never asks for the password, so it is not blocked.
      const nameOnly = await api.patch('/api/account/profile', { displayName: 'Still allowed' });
      expect(nameOnly.status).toBe(200);
    } finally {
      await fresh.close();
    }
  });
});

describe('PWD-7: two password changes at the same moment', () => {
  test('PWD-7 exactly one wins, the session version rises once, and only the winner\'s password works', async () => {
    const first = newPassword();
    const second = newPassword();

    const results = await Promise.all([
      changePassword(ctx.api, { currentPassword: ctx.password, newPassword: first }),
      changePassword(ctx.api, { currentPassword: ctx.password, newPassword: second }),
    ]);

    const statuses = results.map((res) => res.status).sort();
    expect(statuses[0]).toBe(200);
    // The loser is refused either because the row lock showed it the new password (403), or, if the winner had already
    // finished before it was authenticated, because its session was already ended (401).
    expect([401, 403]).toContain(statuses[1]);
    expect((await db.adminRow(ctx.admin.id)).tokenVersion).toBe(1);
    expect(await db.countRows('audit_log')).toBe(1);

    const worked = [
      await loginCookie(ctx.app, ctx.admin.email, first),
      await loginCookie(ctx.app, ctx.admin.email, second),
    ].filter(Boolean);
    expect(worked).toHaveLength(1);
    expect(await loginCookie(ctx.app, ctx.admin.email, ctx.password)).toBeNull();
  });
});
