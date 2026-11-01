// /api/settings with the database layer replaced by fakes: no database is touched. The fake transaction records
// begin / commit / rollback and really puts the stored setting back when a transaction fails (including a row that the
// transaction itself created), so these tests can prove that a setting and its audit record are saved or discarded
// together. They do NOT prove how MySQL locks rows or that the SQL runs; the exact SQL text is checked in
// adminSettingsRepositories.test.js.
const crypto = require('crypto');

process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.CLIENT_ORIGIN = 'http://localhost:5173';

jest.mock('../../src/config/db', () => ({ withTransaction: jest.fn(), getPool: jest.fn() }));
jest.mock('../../src/repositories/auditRepository', () => ({ insert: jest.fn() }));
jest.mock('../../src/repositories/settingsRepository', () => ({
  getValue: jest.fn(),
  ensureRow: jest.fn(),
  getValueForUpdate: jest.fn(),
  upsert: jest.fn(),
}));
jest.mock('../../src/repositories/adminRepository', () => ({
  findByEmail: jest.fn(),
  findById: jest.fn(),
  countAll: jest.fn(),
  create: jest.fn(),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../../src/config/db');
const auditRepository = require('../../src/repositories/auditRepository');
const settingsRepository = require('../../src/repositories/settingsRepository');
const adminRepository = require('../../src/repositories/adminRepository');
const settingsService = require('../../src/services/settingsService');
const { DETAIL_SCHEMAS, validateAuditEvent, AuditValidationError } = require('../../src/validation/auditSchemas');
const settingsSchemas = require('../../src/validation/settingsSchemas');
const app = require('../../src/app');

const CONNECTION = { name: 'the-one-transaction-connection', query: jest.fn() };
const cookie = () => `admin_token=${jwt.sign({}, process.env.JWT_SECRET, { algorithm: 'HS256', subject: '7', expiresIn: 600 })}`;
const get = ({ withCookie = true } = {}) => {
  const req = request(app).get('/api/settings');
  if (withCookie) req.set('Cookie', cookie());
  return req;
};
const patch = (body, { withCookie = true } = {}) => {
  const req = request(app).patch('/api/settings');
  if (withCookie) req.set('Cookie', cookie());
  return req.send(body);
};

let stored; // the text in app_settings.setting_value for the threshold, or null when there is no row
let events;
let auditEvents;

beforeEach(() => {
  jest.resetAllMocks();
  stored = null;
  events = [];
  auditEvents = [];
  adminRepository.findById.mockResolvedValue({ id: 7, email: 'admin@example.com', is_active: 1 });
  db.withTransaction.mockImplementation(async (fn) => {
    events.push('begin');
    const snapshot = stored; // a failed transaction puts the table back as it was, including a row it created
    try {
      const result = await fn(CONNECTION);
      events.push('commit');
      return result;
    } catch (err) {
      stored = snapshot;
      events.push('rollback');
      throw err;
    }
  });
  settingsRepository.getValue.mockImplementation(async (key, executor) => {
    if (executor) {
      expect(executor).toBe(CONNECTION); // inside the transaction the read uses its connection
      events.push('read');
    }
    return stored;
  });
  settingsRepository.ensureRow.mockImplementation(async (connection, { defaultValue }) => {
    expect(connection).toBe(CONNECTION);
    events.push('ensure-row');
    if (stored === null) stored = defaultValue; // INSERT ... ON DUPLICATE KEY UPDATE: create if missing, else nothing
  });
  settingsRepository.getValueForUpdate.mockImplementation(async (connection) => {
    expect(connection).toBe(CONNECTION);
    events.push('lock-read');
    return stored;
  });
  settingsRepository.upsert.mockImplementation(async (connection, { value }) => {
    expect(connection).toBe(CONNECTION);
    events.push('write:upsert');
    stored = value;
  });
  auditRepository.insert.mockImplementation(async (connection, event) => {
    expect(connection).toBe(CONNECTION);
    events.push(`audit:${event.eventType}`);
    auditEvents.push(event);
    return 1;
  });
});

describe('GET /api/settings', () => {
  test('401 without a session', async () => {
    const res = await get({ withCookie: false });
    expect(res.status).toBe(401);
    expect(settingsRepository.getValue).not.toHaveBeenCalled();
  });

  test('returns the default threshold of 5 when nothing has been saved', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.settings).toEqual({ lowStockThreshold: 5 });
    expect(settingsRepository.getValue).toHaveBeenCalledWith('low_stock_threshold');
  });

  test('returns the saved threshold', async () => {
    stored = '12';
    expect((await get()).body.settings).toEqual({ lowStockThreshold: 12 });
    stored = '0';
    expect((await get()).body.settings).toEqual({ lowStockThreshold: 0 });
    stored = '1000';
    expect((await get()).body.settings).toEqual({ lowStockThreshold: 1000 });
  });

  test.each(['abc', '', '-1', '1001', '5.5', '1e3', ' 7', '07x', '99999', null])('a stored value of %p falls back to the default 5', async (value) => {
    stored = value;
    expect((await get()).body.settings).toEqual({ lowStockThreshold: 5 });
  });

  test('also returns the safe application information, with exactly these four fields', async () => {
    const res = await get();
    expect(Object.keys(res.body).sort()).toEqual(['app', 'settings']);
    expect(Object.keys(res.body.app).sort()).toEqual(['clientVersion', 'environment', 'name', 'serverVersion']);
    expect(res.body.app.name).toBe('ShelfSync');
    expect(res.body.app.serverVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(['development', 'production']).toContain(res.body.app.environment);
  });

  test('never contains credentials, secrets or connection details', async () => {
    const env = require('../../src/config/env');
    const text = JSON.stringify((await get()).body);
    for (const secret of [env.jwt.secret, env.db.password, env.db.user, env.db.name, env.db.host, process.env.JWT_SECRET]) {
      if (secret) expect(text).not.toContain(String(secret));
    }
    expect(text).not.toMatch(/password|secret|DB_|jwt|mysql|connection|inventory_(dev|test)/i);
  });
});

describe('PATCH /api/settings: the first save (no row yet)', () => {
  test('creates the row with one atomic statement, audits default 5 -> new value on the same connection, and commits', async () => {
    const res = await patch({ lowStockThreshold: 8 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ settings: { lowStockThreshold: 8 } });
    expect(events).toEqual(['begin', 'read', 'ensure-row', 'lock-read', 'write:upsert', 'audit:SETTINGS_UPDATED', 'commit']);
    expect(settingsRepository.ensureRow).toHaveBeenCalledWith(CONNECTION, { key: 'low_stock_threshold', defaultValue: '5' });
    expect(settingsRepository.upsert).toHaveBeenCalledWith(CONNECTION, { key: 'low_stock_threshold', value: '8', adminId: 7 });
    expect(auditEvents).toEqual([
      { adminId: 7, eventType: 'SETTINGS_UPDATED', entityType: 'SETTINGS', entityId: null, details: { key: 'low_stock_threshold', from: 5, to: 8 } },
    ]);
    expect(stored).toBe('8');
  });

  test('there is no separate existence check and insert/update: the repository offers only ensureRow and upsert for writing', () => {
    expect(Object.keys(settingsRepository).sort()).toEqual(['ensureRow', 'getValue', 'getValueForUpdate', 'upsert']);
  });

  test('the default of 5 is preserved: the row created to take the lock holds 5, so nothing changes until the real write', async () => {
    let seenByLockedRead;
    settingsRepository.getValueForUpdate.mockImplementation(async () => {
      seenByLockedRead = stored;
      return stored;
    });
    await patch({ lowStockThreshold: 9 });
    expect(seenByLockedRead).toBe('5');
    expect(auditEvents[0].details.from).toBe(5);
  });

  test('a later GET returns what was saved', async () => {
    await patch({ lowStockThreshold: 33 });
    expect((await get()).body.settings).toEqual({ lowStockThreshold: 33 });
  });

  test('two first-time saves at the same moment run one after the other, and both are audited with the truthful old value', async () => {
    // A fake row lock: the first transaction to reach ensureRow holds it until it commits or rolls back.
    const waiting = [];
    let owner = null;
    const acquire = async (connection) => {
      while (owner !== null && owner !== connection) await new Promise((resolve) => waiting.push(resolve));
      owner = connection;
    };
    const release = (connection) => {
      if (owner === connection) owner = null;
      waiting.splice(0).forEach((wake) => wake());
    };
    db.withTransaction.mockImplementation(async (fn) => {
      const connection = { name: 'connection' };
      try {
        return await fn(connection);
      } finally {
        release(connection);
      }
    });
    settingsRepository.getValue.mockImplementation(async () => stored);
    settingsRepository.ensureRow.mockImplementation(async (connection, { defaultValue }) => {
      await acquire(connection);
      if (stored === null) stored = defaultValue;
    });
    settingsRepository.getValueForUpdate.mockImplementation(async () => stored);
    settingsRepository.upsert.mockImplementation(async (connection, { value }) => {
      await new Promise((resolve) => setTimeout(resolve, 5)); // the first writer is slow, the second must wait for it
      stored = value;
    });
    auditRepository.insert.mockImplementation(async (connection, event) => {
      auditEvents.push(event.details);
      return 1;
    });

    await Promise.all([settingsService.updateSettings(7, { lowStockThreshold: 8 }), settingsService.updateSettings(7, { lowStockThreshold: 20 })]);

    expect(auditEvents).toHaveLength(2);
    const [first, second] = auditEvents;
    expect(first.from).toBe(5); // nothing was saved before
    expect(second.from).toBe(first.to); // the second saver saw the first one's value, not a stale 5
    expect([first.to, second.to].sort((a, b) => a - b)).toEqual([8, 20]);
    expect(stored).toBe(String(second.to));
  });
});

describe('PATCH /api/settings: changing a saved value', () => {
  test('changes the row with the same atomic statement and records the real old value', async () => {
    stored = '8';
    const res = await patch({ lowStockThreshold: 20 });
    expect(res.status).toBe(200);
    expect(events).toEqual(['begin', 'read', 'ensure-row', 'lock-read', 'write:upsert', 'audit:SETTINGS_UPDATED', 'commit']);
    expect(settingsRepository.upsert).toHaveBeenCalledWith(CONNECTION, { key: 'low_stock_threshold', value: '20', adminId: 7 });
    expect(auditEvents[0].details).toEqual({ key: 'low_stock_threshold', from: 8, to: 20 });
    expect(stored).toBe('20');
  });

  test.each([0, 1, 5, 1000])('accepts %i at the edges of the range', async (value) => {
    stored = '7';
    const res = await patch({ lowStockThreshold: value });
    expect(res.status).toBe(200);
    expect(res.body.settings.lowStockThreshold).toBe(value);
    expect(auditEvents[0].details).toEqual({ key: 'low_stock_threshold', from: 7, to: value });
  });

  test('a stored value that is not valid counts as the default, and is corrected by a real change', async () => {
    stored = 'garbage';
    const res = await patch({ lowStockThreshold: 6 });
    expect(res.status).toBe(200);
    expect(auditEvents[0].details).toEqual({ key: 'low_stock_threshold', from: 5, to: 6 });
    expect(stored).toBe('6');
  });

  test('the "from" in the audit record is the value read under the lock, not the earlier unlocked read', async () => {
    settingsRepository.getValue.mockImplementationOnce(async () => '8'); // what the first, unlocked read saw
    stored = '30'; // what another administrator saved in the meantime
    const res = await patch({ lowStockThreshold: 20 });
    expect(res.status).toBe(200);
    expect(auditEvents[0].details).toEqual({ key: 'low_stock_threshold', from: 30, to: 20 });
  });
});

describe('PATCH /api/settings: nothing really changes', () => {
  test('the value already in force when nothing is saved (the default) sends no write at all and creates no row', async () => {
    const res = await patch({ lowStockThreshold: 5 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ settings: { lowStockThreshold: 5 } });
    expect(events).toEqual(['begin', 'read', 'commit']);
    expect(settingsRepository.ensureRow).not.toHaveBeenCalled();
    expect(settingsRepository.upsert).not.toHaveBeenCalled();
    expect(auditRepository.insert).not.toHaveBeenCalled();
    expect(stored).toBeNull(); // still no row
  });

  test('the value already saved sends no write and no audit record', async () => {
    stored = '9';
    const res = await patch({ lowStockThreshold: 9 });
    expect(res.status).toBe(200);
    expect(events).toEqual(['begin', 'read', 'commit']);
    expect(settingsRepository.upsert).not.toHaveBeenCalled();
    expect(auditRepository.insert).not.toHaveBeenCalled();
    expect(stored).toBe('9');
  });

  test('if someone else saves this very value between the two reads, nothing is written and nothing is audited', async () => {
    settingsRepository.getValue.mockImplementationOnce(async () => '8'); // looked like a change...
    stored = '20'; // ...but another administrator has just saved 20
    const res = await patch({ lowStockThreshold: 20 });
    expect(res.status).toBe(200);
    expect(events).toEqual(['begin', 'ensure-row', 'lock-read', 'commit']);
    expect(settingsRepository.upsert).not.toHaveBeenCalled();
    expect(auditRepository.insert).not.toHaveBeenCalled();
    expect(stored).toBe('20');
  });
});

describe('PATCH /api/settings: rollback', () => {
  test('if the audit write fails, a saved value is put back and the answer is a generic 500', async () => {
    stored = '8';
    auditRepository.insert.mockRejectedValue(new Error('audit down'));
    const res = await patch({ lowStockThreshold: 20 });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(stored).toBe('8');
    expect(events).toEqual(['begin', 'read', 'ensure-row', 'lock-read', 'write:upsert', 'rollback']);
  });

  test('if the audit write fails on a FIRST save, the row is gone again: no new row, no default row, nothing left behind', async () => {
    auditRepository.insert.mockRejectedValue(new Error('audit down'));
    const res = await patch({ lowStockThreshold: 20 });
    expect(res.status).toBe(500);
    expect(stored).toBeNull();
    expect((await get()).body.settings).toEqual({ lowStockThreshold: 5 }); // still the default
  });

  test('if saving fails, nothing is audited and the transaction is rolled back', async () => {
    settingsRepository.upsert.mockRejectedValue(new Error('upsert failed'));
    const res = await patch({ lowStockThreshold: 20 });
    expect(res.status).toBe(500);
    expect(auditRepository.insert).not.toHaveBeenCalled();
    expect(events.at(-1)).toBe('rollback');
    expect(stored).toBeNull();
  });

  test('if creating the row fails, nothing else is sent', async () => {
    settingsRepository.ensureRow.mockRejectedValue(new Error('ensure failed'));
    const res = await patch({ lowStockThreshold: 20 });
    expect(res.status).toBe(500);
    expect(settingsRepository.getValueForUpdate).not.toHaveBeenCalled();
    expect(settingsRepository.upsert).not.toHaveBeenCalled();
    expect(auditRepository.insert).not.toHaveBeenCalled();
    expect(events).toEqual(['begin', 'read', 'rollback']); // (the rejecting mock replaces the one that records 'ensure-row')
  });
});

describe('PATCH /api/settings: validation and access', () => {
  test.each([
    ['one above the range', { lowStockThreshold: 1001 }],
    ['negative', { lowStockThreshold: -1 }],
    ['a decimal', { lowStockThreshold: 1.5 }],
    ['text', { lowStockThreshold: '8' }],
    ['null', { lowStockThreshold: null }],
    ['a boolean', { lowStockThreshold: true }],
    ['an array', { lowStockThreshold: [8] }],
    ['an object', { lowStockThreshold: { value: 8 } }],
    ['a huge number', { lowStockThreshold: 1e21 }],
    ['missing', {}],
  ])('400 for a threshold that is %s, naming the field, and nothing is written', async (_label, body) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', fields: ['lowStockThreshold'] });
    expect(db.withTransaction).not.toHaveBeenCalled();
    expect(auditRepository.insert).not.toHaveBeenCalled();
  });

  test.each(['key', 'setting_key', 'jwtSecret', 'environment', 'updatedBy', 'adminId'])('a supplied "%s" property is rejected and named', async (key) => {
    const res = await patch({ lowStockThreshold: 8, [key]: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', fields: [key] });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('401 without a session, 403 from another origin, and the database is not touched', async () => {
    expect((await patch({ lowStockThreshold: 8 }, { withCookie: false })).status).toBe(401);
    const cross = await request(app).patch('/api/settings').set('Cookie', cookie()).set('Origin', 'http://evil.example').send({ lowStockThreshold: 8 });
    expect(cross.status).toBe(403);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('401 for a session that is older than the last password change', async () => {
    adminRepository.findById.mockResolvedValue({ id: 7, email: 'admin@example.com', is_active: 1, token_version: 1 });
    expect((await patch({ lowStockThreshold: 8 })).status).toBe(401); // the cookie has no tv, so it is version 0
    expect(db.withTransaction).not.toHaveBeenCalled();
  });
});

describe('thresholdFrom', () => {
  test('turns stored text into a number, or the default', () => {
    expect(settingsService.thresholdFrom('0')).toBe(0);
    expect(settingsService.thresholdFrom('1000')).toBe(1000);
    expect(settingsService.thresholdFrom('1001')).toBe(5);
    expect(settingsService.thresholdFrom(null)).toBe(5);
    expect(settingsService.thresholdFrom(undefined)).toBe(5);
    expect(settingsService.thresholdFrom(8)).toBe(5); // not text: never trusted
  });
});

describe('the settings rules and the audit rules agree', () => {
  test('same key, same range and same default', () => {
    expect(settingsSchemas.LOW_STOCK_THRESHOLD_KEY).toBe('low_stock_threshold');
    expect(settingsSchemas.DEFAULT_LOW_STOCK_THRESHOLD).toBe(5);
    expect(settingsSchemas.MIN_LOW_STOCK_THRESHOLD).toBe(0);
    expect(settingsSchemas.MAX_LOW_STOCK_THRESHOLD).toBe(1000);
    const audit = (details) => validateAuditEvent({ eventType: 'SETTINGS_UPDATED', entityId: null, details });
    expect(audit({ key: settingsSchemas.LOW_STOCK_THRESHOLD_KEY, from: 0, to: 1000 }).details.to).toBe(1000);
    expect(() => audit({ key: settingsSchemas.LOW_STOCK_THRESHOLD_KEY, from: 0, to: 1001 })).toThrow(AuditValidationError);
    expect(() => audit({ key: 'something_else', from: 0, to: 1 })).toThrow(AuditValidationError);
    expect(DETAIL_SCHEMAS.SETTINGS_UPDATED).toBeDefined();
  });
});
