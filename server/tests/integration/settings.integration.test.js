// Settings against the real MySQL TEST database (inventory_test): reading and saving the low-stock threshold, the audit
// record of a change, validation, and two administrators saving for the first time at the same moment.
// This file WRITES to the test database: every test starts from empty tables (resetTestDatabase) and the tables are
// emptied again afterwards. See tests/helpers/integrationEnv.js for the guards that refuse to run against anything but
// inventory_test.
const { INTEGRATION_TIMEOUT, query, useIntegrationDatabase } = require('../helpers/integrationEnv');
const f = require('../helpers/factories');
const db = require('../helpers/dbAssert');
const { client, cookieFor } = require('../helpers/http');
const { assertNoSecrets } = require('../helpers/privacy');

jest.setTimeout(INTEGRATION_TIMEOUT);

const ctx = useIntegrationDatabase();

const KEY = 'low_stock_threshold';
const getThreshold = async () => (await ctx.api.get('/api/settings')).body.settings.lowStockThreshold;
const save = (value) => ctx.api.patch('/api/settings', { lowStockThreshold: value });

describe('SET-1: reading settings', () => {
  test('SET-1 the threshold is 5 until something is saved, and the app information holds no secrets', async () => {
    const res = await ctx.api.get('/api/settings');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.settings).toEqual({ lowStockThreshold: 5 });
    expect(res.body.app).toMatchObject({ name: 'ShelfSync', environment: 'development' });
    expect(Object.keys(res.body.app).sort()).toEqual(['clientVersion', 'environment', 'name', 'serverVersion']);
    expect(await db.countRows('app_settings')).toBe(0); // reading creates nothing
    assertNoSecrets(res.body);
  });
});

describe('SET-2 / SET-3: saving the threshold', () => {
  test('SET-2 a saved value is read back, stored with the administrator, and recorded once in the audit log', async () => {
    const res = await save(8);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ settings: { lowStockThreshold: 8 } });
    expect(await getThreshold()).toBe(8);
    expect(await db.settingRow(KEY)).toEqual({ value: '8', updatedByAdminId: ctx.admin.id });
    expect((await db.auditRows()).map(({ id, ...rest }) => rest)).toEqual([
      {
        adminId: ctx.admin.id,
        eventType: 'SETTINGS_UPDATED',
        entityType: 'SETTINGS',
        entityId: null,
        details: { key: KEY, from: 5, to: 8 },
      },
    ]);

    const again = await save(12);
    expect(again.status).toBe(200);
    expect(await getThreshold()).toBe(12);
    const rows = await db.auditRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].details).toEqual({ key: KEY, from: 8, to: 12 });
    expect(await db.countRows('app_settings')).toBe(1); // one row per setting, updated in place
  });

  test('SET-3 saving the value already in force changes and records nothing', async () => {
    // Nothing saved yet: 5 is already the effective value, so no row is even created.
    const first = await save(5);
    expect(first.status).toBe(200);
    expect(first.body.settings.lowStockThreshold).toBe(5);
    expect(await db.settingRow(KEY)).toBeNull();
    expect(await db.countRows('audit_log')).toBe(0);

    expect((await save(8)).status).toBe(200);
    expect((await save(8)).status).toBe(200); // the same value again
    expect(await db.countRows('audit_log')).toBe(1);
    expect(await getThreshold()).toBe(8);
  });

  test('SET-3 the boundaries 0 and 1000 are accepted', async () => {
    expect((await save(0)).body.settings.lowStockThreshold).toBe(0);
    expect(await getThreshold()).toBe(0);
    expect((await save(1000)).body.settings.lowStockThreshold).toBe(1000);
    expect(await getThreshold()).toBe(1000);
    expect((await db.auditRows()).map((row) => [row.details.from, row.details.to])).toEqual([[5, 0], [0, 1000]]);
  });
});

describe('SET-4: invalid values', () => {
  const INVALID = [
    ['-1', { lowStockThreshold: -1 }],
    ['1001', { lowStockThreshold: 1001 }],
    ['a fractional number', { lowStockThreshold: 8.5 }],
    ['text instead of a number', { lowStockThreshold: '8' }],
    ['null', { lowStockThreshold: null }],
    ['a missing value', {}],
    ['an unknown extra property', { lowStockThreshold: 8, somethingElse: 1 }],
    ['an unknown property alone', { threshold: 8 }],
  ];

  test.each(INVALID)('SET-4 rejects %s with 400 and saves nothing', async (_name, body) => {
    const res = await ctx.api.patch('/api/settings', body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
    expect(await getThreshold()).toBe(5);
    expect(await db.settingRow(KEY)).toBeNull();
    expect(await db.countRows('audit_log')).toBe(0);
  });

  test('SET-4 a request with no body at all is a 400', async () => {
    const res = await ctx.api.patch('/api/settings');

    expect(res.status).toBe(400);
    expect(await db.countRows('app_settings')).toBe(0);
  });
});

describe('SET-5: two administrators saving at the same moment', () => {
  test('SET-5 two first-time saves of different values both succeed and leave a consistent history', async () => {
    const other = await f.createAdmin({ passwordHash: ctx.passwordHash });
    const otherApi = client(ctx.app, cookieFor(other));

    const [a, b] = await Promise.all([
      ctx.api.patch('/api/settings', { lowStockThreshold: 7 }),
      otherApi.patch('/api/settings', { lowStockThreshold: 9 }),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const stored = Number((await db.settingRow(KEY)).value);
    expect([7, 9]).toContain(stored);
    expect(await getThreshold()).toBe(stored);
    // The two saves ran one after the other: the history is a chain 5 -> first -> second, and ends at the stored value.
    const rows = await db.auditRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].details.from).toBe(5);
    expect(rows[1].details.from).toBe(rows[0].details.to);
    expect(rows[1].details.to).toBe(stored);
    expect([rows[0].details.to, rows[1].details.to].sort()).toEqual([7, 9]);
    expect(await db.countRows('app_settings')).toBe(1);
  });
});

describe('SET-6: a damaged stored value', () => {
  test('SET-6 text that is not a valid number reads as the default', async () => {
    await query('INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)', [KEY, 'abc']);
    expect(await getThreshold()).toBe(5);

    await query('UPDATE app_settings SET setting_value = ? WHERE setting_key = ?', ['5000', KEY]); // out of range
    expect(await getThreshold()).toBe(5);

    await query('UPDATE app_settings SET setting_value = ? WHERE setting_key = ?', ['12', KEY]);
    expect(await getThreshold()).toBe(12);
  });
});
