// auditService / auditRepository with a fake connection: no database is touched.
const fs = require('fs');
const path = require('path');
const auditRepository = require('../../src/repositories/auditRepository');
const auditService = require('../../src/services/auditService');

const makeConnection = () => ({ query: jest.fn().mockResolvedValue([{ insertId: 77 }]) });

describe('auditRepository.insert', () => {
  test('inserts one row with placeholders and stringified details', async () => {
    const connection = makeConnection();
    const id = await auditRepository.insert(connection, {
      adminId: 7,
      eventType: 'CUSTOMER_UPDATED',
      entityType: 'CUSTOMER',
      entityId: 3,
      details: { changedFields: ['name'] },
    });
    expect(id).toBe(77);
    const [sql, values] = connection.query.mock.calls[0];
    expect(sql).toBe('INSERT INTO audit_log (admin_id, event_type, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)');
    expect(values).toEqual([7, 'CUSTOMER_UPDATED', 'CUSTOMER', 3, '{"changedFields":["name"]}']);
  });

  test('null details are stored as SQL NULL', async () => {
    const connection = makeConnection();
    await auditRepository.insert(connection, { adminId: 7, eventType: 'PRODUCT_ACTIVATED', entityType: 'PRODUCT', entityId: 3, details: null });
    expect(connection.query.mock.calls[0][1][4]).toBeNull();
  });

  test('refuses a connection pool and anything that is not a connection', async () => {
    const pool = { query: jest.fn(), getConnection: jest.fn() };
    await expect(auditRepository.insert(pool, { adminId: 1, eventType: 'PRODUCT_ACTIVATED', entityType: 'PRODUCT', entityId: 1, details: null })).rejects.toThrow(/open transaction/);
    for (const bad of [undefined, null, {}, 'connection', 42]) {
      await expect(auditRepository.insert(bad, { adminId: 1, eventType: 'PRODUCT_ACTIVATED', entityType: 'PRODUCT', entityId: 1, details: null })).rejects.toThrow(/open transaction/);
    }
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('is append-only: the only export is insert', () => {
    expect(Object.keys(auditRepository)).toEqual(['insert']);
  });
});

describe('auditService.record', () => {
  test('validates, then writes on the connection it was given', async () => {
    const connection = makeConnection();
    const id = await auditService.record(connection, { adminId: 7, eventType: 'PRODUCT_DEACTIVATED', entityId: 5 });
    expect(id).toBe(77);
    expect(connection.query).toHaveBeenCalledTimes(1);
    expect(connection.query.mock.calls[0][1]).toEqual([7, 'PRODUCT_DEACTIVATED', 'PRODUCT', 5, null]);
  });

  test('settings events are written with no entity id', async () => {
    const connection = makeConnection();
    await auditService.record(connection, { adminId: 7, eventType: 'SETTINGS_UPDATED', details: { key: 'low_stock_threshold', from: 5, to: 8 } });
    expect(connection.query.mock.calls[0][1]).toEqual([7, 'SETTINGS_UPDATED', 'SETTINGS', null, '{"key":"low_stock_threshold","from":5,"to":8}']);
  });

  test('writes nothing when the event or its details are not allowed', async () => {
    const connection = makeConnection();
    const attempts = [
      { adminId: 7, eventType: 'NOPE', entityId: 1 },
      { adminId: 7, eventType: 'CUSTOMER_UPDATED', entityId: 1, details: { changedFields: ['email'], email: 'ann@example.com' } },
      { adminId: 7, eventType: 'ACCOUNT_PASSWORD_CHANGED', entityId: 1, details: { password: 'secret-password-1' } },
      { adminId: 7, eventType: 'PRODUCT_ACTIVATED', entityId: 'abc' },
      { adminId: 0, eventType: 'PRODUCT_ACTIVATED', entityId: 1 },
      { adminId: '7', eventType: 'PRODUCT_ACTIVATED', entityId: 1 },
      { adminId: undefined, eventType: 'PRODUCT_ACTIVATED', entityId: 1 },
    ];
    for (const attempt of attempts) {
      await expect(auditService.record(connection, attempt)).rejects.toBeInstanceOf(auditService.AuditValidationError);
    }
    expect(connection.query).not.toHaveBeenCalled();
  });

  test('never writes through a pool, even for a valid event', async () => {
    const pool = { query: jest.fn(), getConnection: jest.fn() };
    await expect(auditService.record(pool, { adminId: 7, eventType: 'PRODUCT_ACTIVATED', entityId: 5 })).rejects.toThrow(/open transaction/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('free text is refused, not cleaned: a product name or SKU can never be written to the log', async () => {
    const connection = makeConnection();
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXRleHQ';
    const attempts = [
      { eventType: 'PRODUCT_UPDATED', entityId: 5, details: { changedFields: ['name'], changes: { name: { from: 'Old', to: jwt } } } },
      { eventType: 'PRODUCT_UPDATED', entityId: 5, details: { changedFields: ['name'], changes: { name: { from: 'Old', to: 'Contact john@example.com' } } } },
      { eventType: 'PRODUCT_CREATED', entityId: 5, details: { sku: 'SKU-1', name: 'Call +44 20 7946 0958', price: '1.00' } },
      { eventType: 'PRODUCT_CREATED', entityId: 5, details: { price: '1.00', name: 'Ship to 1 Main St' } },
    ];
    for (const attempt of attempts) {
      await expect(auditService.record(connection, { adminId: 7, ...attempt })).rejects.toBeInstanceOf(auditService.AuditValidationError);
    }
    expect(connection.query).not.toHaveBeenCalled();
  });

  test('a raw request body is never accepted as details, whatever the event', async () => {
    const connection = makeConnection();
    const bodies = [
      { sku: 'SKU-1', name: 'USB Hub', price: '1.00', stockQuantity: 3 },
      { name: 'Ann Lee', email: 'ann@example.com', phone: '555 0100', address: '1 Main St' },
      { email: 'admin@example.com', password: 'secret-password-1' },
      { currentPassword: 'secret-password-1', newPassword: 'another-secret-2' },
    ];
    for (const eventType of ['PRODUCT_CREATED', 'PRODUCT_UPDATED', 'CUSTOMER_CREATED', 'CUSTOMER_UPDATED', 'ACCOUNT_PROFILE_UPDATED', 'ACCOUNT_PASSWORD_CHANGED', 'SETTINGS_UPDATED']) {
      for (const body of bodies) {
        await expect(auditService.record(connection, { adminId: 7, eventType, entityId: eventType === 'SETTINGS_UPDATED' ? null : 5, details: body })).rejects.toBeInstanceOf(auditService.AuditValidationError);
      }
    }
    expect(connection.query).not.toHaveBeenCalled();
  });

  test('nothing stored by any valid event contains a password, hash, token, email or phone number', async () => {
    const connection = makeConnection();
    const valid = [
      ['PRODUCT_CREATED', 1, { price: '9.99' }],
      ['PRODUCT_UPDATED', 1, { changedFields: ['name', 'price'], changes: { price: { from: '1.00', to: '2.00' } } }],
      ['PRODUCT_ACTIVATED', 1, null],
      ['PRODUCT_DEACTIVATED', 1, null],
      ['CUSTOMER_CREATED', 2, null],
      ['CUSTOMER_UPDATED', 2, { changedFields: ['name', 'email', 'phone', 'address'] }],
      ['CUSTOMER_ACTIVATED', 2, null],
      ['CUSTOMER_DEACTIVATED', 2, null],
      ['ACCOUNT_PROFILE_UPDATED', 1, { changedFields: ['displayName', 'email'] }],
      ['ACCOUNT_PASSWORD_CHANGED', 1, null],
      ['SETTINGS_UPDATED', null, { key: 'low_stock_threshold', from: 5, to: 6 }],
    ];
    for (const [eventType, entityId, details] of valid) {
      await auditService.record(connection, { adminId: 7, eventType, entityId, details });
    }
    expect(connection.query).toHaveBeenCalledTimes(11);
    for (const [, values] of connection.query.mock.calls) {
      const stored = String(values[4] ?? '');
      expect(stored).not.toMatch(/@|password|hash|token|secret|\$2[aby]\$|eyJ|\d{3}[ -]\d{4}/i);
    }
  });
});

describe('append-only audit_log in the whole code base', () => {
  const srcDir = path.join(__dirname, '..', '..', 'src');
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  })(srcDir);

  test('no source file runs UPDATE, DELETE, TRUNCATE, DROP or ALTER on audit_log', () => {
    const offenders = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      if (/\b(UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?|DROP\s+TABLE|ALTER\s+TABLE|REPLACE\s+INTO)\s+`?audit_log\b/i.test(text)) {
        offenders.push(path.relative(srcDir, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  test('only auditRepository inserts into audit_log', () => {
    const inserters = files
      .filter((file) => /INSERT\s+INTO\s+`?audit_log\b/i.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(srcDir, file).replace(/\\/g, '/'));
    expect(inserters).toEqual(['repositories/auditRepository.js']);
  });
});
