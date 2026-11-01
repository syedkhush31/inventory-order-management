// The SQL text and values built by adminRepository and settingsRepository, using fake pools and connections.
// This proves how the statements are assembled (placeholders, whitelisted columns, one atomic password statement,
// no hash in the profile). It does NOT prove they run on a real MySQL server.
const fs = require('fs');
const path = require('path');

const mockExecute = jest.fn();
const mockQuery = jest.fn();
jest.mock('../../src/config/db', () => ({ getPool: () => ({ execute: mockExecute, query: mockQuery }) }));

const adminRepository = require('../../src/repositories/adminRepository');
const settingsRepository = require('../../src/repositories/settingsRepository');

const squash = (sql) => sql.replace(/\s+/g, ' ').trim();
const placeholders = (sql) => (sql.match(/\?/g) || []).length;
const connection = () => ({ query: jest.fn().mockResolvedValue([[]]) });

beforeEach(() => {
  mockExecute.mockReset().mockResolvedValue([[]]);
  mockQuery.mockReset().mockResolvedValue([[]]);
});

describe('adminRepository reads', () => {
  test('findByEmail reads the hash (login needs it) and the session version, with a placeholder', async () => {
    await adminRepository.findByEmail('a@b.co');
    const [sql, values] = mockExecute.mock.calls[0];
    expect(squash(sql)).toBe('SELECT id, email, password_hash, is_active, token_version FROM admins WHERE email = ? LIMIT 1');
    expect(values).toEqual(['a@b.co']);
  });

  test('findById (used on every request) reads the session version and NOT the hash', async () => {
    await adminRepository.findById(7);
    const [sql, values] = mockExecute.mock.calls[0];
    expect(squash(sql)).toBe('SELECT id, email, is_active, token_version FROM admins WHERE id = ? LIMIT 1');
    expect(sql).not.toMatch(/password/i);
    expect(values).toEqual([7]);
  });

  test('findProfile (the Settings page) reads neither the hash nor the session version', async () => {
    await adminRepository.findProfile(7);
    const [sql, values] = mockExecute.mock.calls[0];
    expect(squash(sql)).toBe('SELECT id, email, display_name, created_at FROM admins WHERE id = ? LIMIT 1');
    expect(sql).not.toMatch(/password|token_version|is_active/i);
    expect(values).toEqual([7]);
  });

  test('returns null when there is no row', async () => {
    expect(await adminRepository.findByEmail('x@y.co')).toBeNull();
    expect(await adminRepository.findById(1)).toBeNull();
    expect(await adminRepository.findProfile(1)).toBeNull();
  });
});

describe('adminRepository writes use the transaction connection and the pool is never touched', () => {
  test('findForUpdate locks the row with FOR UPDATE and a placeholder', async () => {
    const c = connection();
    c.query.mockResolvedValue([[{ id: 7 }]]);
    expect(await adminRepository.findForUpdate(c, 7)).toEqual({ id: 7 });
    const [sql, values] = c.query.mock.calls[0];
    expect(squash(sql)).toMatch(/^SELECT id, email, display_name, password_hash, is_active, token_version, created_at FROM admins WHERE id = \? LIMIT 1 FOR UPDATE$/);
    expect(values).toEqual([7]);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('updateProfile changes only the whitelisted columns, with placeholders', async () => {
    const c = connection();
    await adminRepository.updateProfile(c, 7, { displayName: 'Sam', email: 'new@example.com' });
    const [sql, values] = c.query.mock.calls[0];
    expect(squash(sql)).toBe('UPDATE admins SET display_name = ?, email = ? WHERE id = ?');
    expect(values).toEqual(['Sam', 'new@example.com', 7]);
  });

  test('updateProfile can clear the display name with null, and change one field alone', async () => {
    const c = connection();
    await adminRepository.updateProfile(c, 7, { displayName: null });
    expect(squash(c.query.mock.calls[0][0])).toBe('UPDATE admins SET display_name = ? WHERE id = ?');
    expect(c.query.mock.calls[0][1]).toEqual([null, 7]);
    await adminRepository.updateProfile(c, 7, { email: 'x@y.co' });
    expect(squash(c.query.mock.calls[1][0])).toBe('UPDATE admins SET email = ? WHERE id = ?');
  });

  test('updateProfile can never touch the hash, the version, the active flag or any other column', async () => {
    const c = connection();
    await adminRepository.updateProfile(c, 7, { password_hash: 'x', passwordHash: 'x', token_version: 99, tokenVersion: 99, is_active: 0, isActive: 0, id: 8, role: 'root' });
    expect(c.query).not.toHaveBeenCalled(); // nothing on the list, so no statement at all
    await adminRepository.updateProfile(c, 7, { displayName: 'Sam', password_hash: 'x', token_version: 99, 'display_name = 1; DROP TABLE admins; --': 1 });
    const [sql, values] = c.query.mock.calls[0];
    expect(squash(sql)).toBe('UPDATE admins SET display_name = ? WHERE id = ?');
    expect(values).toEqual(['Sam', 7]);
    expect(Object.keys(adminRepository.PROFILE_COLUMNS).sort()).toEqual(['displayName', 'email']);
  });

  test('updateProfile with nothing to change sends nothing', async () => {
    const c = connection();
    await adminRepository.updateProfile(c, 7, {});
    await adminRepository.updateProfile(c, 7, { displayName: undefined, email: undefined });
    expect(c.query).not.toHaveBeenCalled();
  });

  test('the password hash and the session version change in ONE statement (they can never be out of step)', async () => {
    const c = connection();
    await adminRepository.updatePasswordAndBumpVersion(c, 7, '$2b$12$hashhashhash');
    expect(c.query).toHaveBeenCalledTimes(1);
    const [sql, values] = c.query.mock.calls[0];
    expect(squash(sql)).toBe('UPDATE admins SET password_hash = ?, token_version = token_version + 1 WHERE id = ?');
    expect(values).toEqual(['$2b$12$hashhashhash', 7]);
    expect(placeholders(sql)).toBe(values.length);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('the version is raised inside the database (token_version + 1), not computed in Node from an old read', async () => {
    const c = connection();
    await adminRepository.updatePasswordAndBumpVersion(c, 7, 'h');
    expect(c.query.mock.calls[0][0]).toMatch(/token_version = token_version \+ 1/);
    expect(c.query.mock.calls[0][1]).not.toContain(1);
  });
});

describe('settingsRepository', () => {
  test('getValue reads one setting with a placeholder and returns text, or null when there is no row', async () => {
    mockQuery.mockResolvedValueOnce([[{ setting_value: 12 }]]).mockResolvedValueOnce([[]]);
    expect(await settingsRepository.getValue('low_stock_threshold')).toBe('12');
    expect(squash(mockQuery.mock.calls[0][0])).toBe('SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1');
    expect(mockQuery.mock.calls[0][1]).toEqual(['low_stock_threshold']);
    expect(await settingsRepository.getValue('missing')).toBeNull();
  });

  test('getValue reads on the transaction connection when it is given one, and takes no lock', async () => {
    const c = connection();
    c.query.mockResolvedValue([[{ setting_value: '8' }]]);
    expect(await settingsRepository.getValue('low_stock_threshold', c)).toBe('8');
    expect(squash(c.query.mock.calls[0][0])).toBe('SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1');
    expect(c.query.mock.calls[0][0]).not.toMatch(/FOR UPDATE|FOR SHARE|LOCK/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('the only writes are two INSERT ... ON DUPLICATE KEY UPDATE statements: there is no separate insert or update function', () => {
    expect(Object.keys(settingsRepository).sort()).toEqual(['ensureRow', 'getValue', 'getValueForUpdate', 'upsert']);
  });

  test('ensureRow is one atomic statement that creates a missing row holding the default and changes nothing otherwise', async () => {
    const c = connection();
    await settingsRepository.ensureRow(c, { key: 'low_stock_threshold', defaultValue: '5' });
    expect(c.query).toHaveBeenCalledTimes(1);
    const [sql, values] = c.query.mock.calls[0];
    expect(squash(sql)).toBe(
      'INSERT INTO app_settings (setting_key, setting_value, updated_by_admin_id) VALUES (?, ?, NULL) ON DUPLICATE KEY UPDATE setting_value = setting_value'
    );
    expect(values).toEqual(['low_stock_threshold', '5']);
    expect(placeholders(sql)).toBe(values.length);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('upsert is one atomic statement: insert the row if missing, otherwise change it, and record who saved it', async () => {
    const c = connection();
    await settingsRepository.upsert(c, { key: 'low_stock_threshold', value: '8', adminId: 7 });
    expect(c.query).toHaveBeenCalledTimes(1);
    const [sql, values] = c.query.mock.calls[0];
    expect(squash(sql)).toBe(
      'INSERT INTO app_settings (setting_key, setting_value, updated_by_admin_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE setting_value = ?, updated_by_admin_id = ?'
    );
    expect(values).toEqual(['low_stock_threshold', '8', 7, '8', 7]);
    expect(placeholders(sql)).toBe(values.length);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('neither write uses the deprecated VALUES() function: the new values are passed as parameters', async () => {
    const c = connection();
    await settingsRepository.ensureRow(c, { key: 'k', defaultValue: '5' });
    await settingsRepository.upsert(c, { key: 'k', value: '1', adminId: 7 });
    for (const [sql] of c.query.mock.calls) expect(sql).not.toMatch(/VALUES\s*\(\s*[a-z_]+\s*\)/i);
  });

  test('getValueForUpdate locks the (now existing) row on the transaction connection', async () => {
    const c = connection();
    c.query.mockResolvedValue([[{ setting_value: '8' }]]);
    expect(await settingsRepository.getValueForUpdate(c, 'low_stock_threshold')).toBe('8');
    expect(squash(c.query.mock.calls[0][0])).toBe('SELECT setting_value FROM app_settings WHERE setting_key = ? LIMIT 1 FOR UPDATE');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('a hostile key or value is only ever a value, never part of the SQL', async () => {
    const c = connection();
    const key = "x'; DROP TABLE app_settings;--";
    const value = "1'); DROP TABLE admins;--";
    await settingsRepository.ensureRow(c, { key, defaultValue: value });
    await settingsRepository.upsert(c, { key, value, adminId: 7 });
    for (const [sql] of c.query.mock.calls) expect(sql).not.toMatch(/DROP|x'|1'\)/);
  });
});

describe('the settings SQL fits the table that migration 003 created', () => {
  const databaseDir = path.join(__dirname, '..', '..', 'database');
  const tableIn = (file) => {
    const sql = fs.readFileSync(path.join(databaseDir, file), 'utf8');
    return /CREATE TABLE app_settings \([\s\S]*?\) ENGINE=InnoDB/.exec(sql)[0];
  };

  test.each(['migrations/003_add_audit_log_and_settings.sql', 'schema.sql'])('%s: the columns the statements use exist, and setting_key is the primary key', (file) => {
    const table = tableIn(file);
    // ON DUPLICATE KEY UPDATE only works on a PRIMARY or UNIQUE key: setting_key is the primary key.
    expect(table).toMatch(/PRIMARY KEY \(setting_key\)/);
    expect(table).toMatch(/setting_key\s+VARCHAR\(64\)\s+NOT NULL/);
    expect(table).toMatch(/setting_value\s+VARCHAR\(255\)\s+NOT NULL/);
    // ensureRow inserts NULL for the administrator, so the column must allow NULL.
    expect(table).toMatch(/updated_by_admin_id\s+BIGINT UNSIGNED NULL/);
    expect(table).toMatch(/updated_at\s+TIMESTAMP\s+NOT NULL DEFAULT CURRENT_TIMESTAMP/);
  });

  test('every column named in the repository SQL is a column of that table', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'repositories', 'settingsRepository.js'), 'utf8');
    const used = new Set(source.match(/\b(setting_key|setting_value|updated_by_admin_id|updated_at)\b/g));
    const table = tableIn('migrations/003_add_audit_log_and_settings.sql');
    for (const column of used) expect(table).toContain(column);
    expect([...used].sort()).toEqual(['setting_key', 'setting_value', 'updated_by_admin_id']);
  });

  test('the default written by ensureRow is the application default, and fits the column', () => {
    const { DEFAULT_LOW_STOCK_THRESHOLD } = require('../../src/validation/settingsSchemas');
    expect(String(DEFAULT_LOW_STOCK_THRESHOLD).length).toBeLessThanOrEqual(255);
    expect(DEFAULT_LOW_STOCK_THRESHOLD).toBe(5);
  });
});

describe('both repositories', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'repositories', file), 'utf8');

  test('never use SELECT *, so a column added later (a hash, a secret) can not leak by accident', () => {
    for (const file of ['adminRepository.js', 'settingsRepository.js']) expect(read(file)).not.toMatch(/SELECT\s+\*/i);
  });

  test('build SQL from literals only: the one template string takes its columns from a fixed whitelist', () => {
    const source = read('adminRepository.js');
    const templates = source.match(/`[^`]*\$\{[^}]*\}[^`]*`/g) || [];
    // exactly two: the column list built from the whitelist, and the UPDATE that uses it
    expect(templates).toEqual(['`${PROFILE_COLUMNS[key]} = ?`', '`UPDATE admins SET ${assignments} WHERE id = ?`']);
    expect(read('settingsRepository.js')).not.toMatch(/\$\{/);
  });
});
