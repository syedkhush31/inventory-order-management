// The audit allowlists: which events exist, which details each may carry, and what is refused.
// Pure validation: no database is touched.
//
// Privacy rule under test: audit_log never holds text that a person typed. The only strings that can be stored are fixed
// field names, a digits-only price, and the one setting key. Nothing relies on spotting bad text with patterns.
const fs = require('fs');
const path = require('path');
const {
  EVENT_TYPES,
  ENTITY_TYPE_BY_EVENT,
  DETAIL_SCHEMAS,
  AuditValidationError,
  validateAuditEvent,
} = require('../../src/validation/auditSchemas');

const ok = (eventType, entityId, details) => validateAuditEvent({ eventType, entityId, details });
const rejects = (eventType, entityId, details) => expect(() => ok(eventType, entityId, details)).toThrow(AuditValidationError);

// Things that must never be stored, in several shapes.
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXRleHQ';
const BCRYPT = '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456';
const SENSITIVE_TEXTS = [
  'secret-password-1',
  JWT,
  BCRYPT,
  'john.smith@example.com',
  '+44 20 7946 0958',
  '555 0100',
  '1 Main St, Springfield',
  'Bearer abc.def.ghi',
];

describe('event list', () => {
  test('matches the event_type ENUM in migration 003 and schema.sql, in order', () => {
    const databaseDir = path.join(__dirname, '..', '..', 'database');
    for (const file of ['migrations/003_add_audit_log_and_settings.sql', 'schema.sql']) {
      const sql = fs.readFileSync(path.join(databaseDir, file), 'utf8');
      const block = /event_type\s+ENUM\(([\s\S]*?)\)\s+NOT NULL/.exec(sql)[1];
      expect(block.match(/'[A-Z_]+'/g).map((v) => v.slice(1, -1))).toEqual(EVENT_TYPES);
    }
  });

  test('has exactly 11 events, an entity type and a detail rule for each', () => {
    expect(EVENT_TYPES).toHaveLength(11);
    expect(Object.keys(ENTITY_TYPE_BY_EVENT).sort()).toEqual([...EVENT_TYPES].sort());
    expect(Object.keys(DETAIL_SCHEMAS).sort()).toEqual([...EVENT_TYPES].sort());
  });

  test('an unknown event type is refused, including a bare suffix', () => {
    rejects('PRODUCT_DELETED', 1, null);
    rejects('_DEACTIVATED', 1, null);
    rejects('ORDER_CONFIRMED', 1, null);
    rejects(undefined, 1, null);
  });
});

describe('entity ids', () => {
  test('product, customer and account events need a valid id, and the entity type comes from the event', () => {
    expect(ok('PRODUCT_ACTIVATED', 5, null)).toEqual({ eventType: 'PRODUCT_ACTIVATED', entityType: 'PRODUCT', entityId: 5, details: null });
    expect(ok('CUSTOMER_DEACTIVATED', 9, null).entityType).toBe('CUSTOMER');
    expect(ok('ACCOUNT_PASSWORD_CHANGED', 1, null).entityType).toBe('ACCOUNT');
    for (const bad of [undefined, null, 0, -1, 1.5, '3', NaN, 1e16]) rejects('PRODUCT_ACTIVATED', bad, null);
  });

  test('settings events have no entity id', () => {
    const details = { key: 'low_stock_threshold', from: 5, to: 10 };
    expect(ok('SETTINGS_UPDATED', null, details).entityId).toBeNull();
    expect(ok('SETTINGS_UPDATED', undefined, details).entityType).toBe('SETTINGS');
    rejects('SETTINGS_UPDATED', 3, details);
  });
});

describe('details per event', () => {
  test('events without details accept only null', () => {
    for (const type of ['PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED', 'CUSTOMER_CREATED', 'CUSTOMER_ACTIVATED', 'CUSTOMER_DEACTIVATED', 'ACCOUNT_PASSWORD_CHANGED']) {
      expect(ok(type, 1, undefined).details).toBeNull();
      expect(ok(type, 1, null).details).toBeNull();
      rejects(type, 1, {});
      rejects(type, 1, { anything: 1 });
      rejects(type, 1, 'text');
    }
  });

  test('PRODUCT_CREATED stores only the validated price, never the SKU or name', () => {
    expect(ok('PRODUCT_CREATED', 1, { price: '24.50' }).details).toEqual({ price: '24.50' });
    expect(ok('PRODUCT_CREATED', 1, { price: '9' }).details).toEqual({ price: '9' });
    rejects('PRODUCT_CREATED', 1, null);
    rejects('PRODUCT_CREATED', 1, { sku: 'SKU-1', name: 'USB Hub', price: '24.50' }); // free text is refused outright
    rejects('PRODUCT_CREATED', 1, { price: '24.50', sku: 'SKU-1' });
    rejects('PRODUCT_CREATED', 1, { price: '24.50', name: 'USB Hub' });
    rejects('PRODUCT_CREATED', 1, { price: '24.50', stockQuantity: 5 });
    rejects('PRODUCT_CREATED', 1, { price: 24.5 });
    rejects('PRODUCT_CREATED', 1, { price: '1.234' });
    rejects('PRODUCT_CREATED', 1, { price: '-1' });
    rejects('PRODUCT_CREATED', 1, { price: 'john@example.com' });
    rejects('PRODUCT_CREATED', 1, {});
  });

  test('PRODUCT_UPDATED stores changed field names, and old/new values for the price only', () => {
    const priceOnly = { changedFields: ['price'], changes: { price: { from: '10.00', to: '12.50' } } };
    expect(ok('PRODUCT_UPDATED', 1, priceOnly).details).toEqual(priceOnly);
    expect(ok('PRODUCT_UPDATED', 1, { changedFields: ['sku'] }).details).toEqual({ changedFields: ['sku'] });
    expect(ok('PRODUCT_UPDATED', 1, { changedFields: ['sku', 'name'] }).details).toEqual({ changedFields: ['sku', 'name'] });
    const all = { changedFields: ['sku', 'name', 'price'], changes: { price: { from: '1.00', to: '2.00' } } };
    expect(ok('PRODUCT_UPDATED', 1, all).details).toEqual(all);
    rejects('PRODUCT_UPDATED', 1, { changedFields: [] });
    rejects('PRODUCT_UPDATED', 1, { changedFields: ['stock'] });
    rejects('PRODUCT_UPDATED', 1, { changedFields: ['price', 'price'] });
    rejects('PRODUCT_UPDATED', 1, { changedFields: ['price'], note: 'x' });
    rejects('PRODUCT_UPDATED', 1, { changedFields: ['price'], changes: { price: { from: '1', to: '2', extra: 'x' } } });
    rejects('PRODUCT_UPDATED', 1, { changedFields: ['price'], changes: { stockQuantity: { from: '1', to: '2' } } });
    // The old and new text of a SKU or name is free text, so it can not be stored.
    rejects('PRODUCT_UPDATED', 1, { changedFields: ['name'], changes: { name: { from: 'Old', to: 'New' } } });
    rejects('PRODUCT_UPDATED', 1, { changedFields: ['sku'], changes: { sku: { from: 'A-1', to: 'A-2' } } });
    rejects('PRODUCT_UPDATED', 1, { changedFields: ['name', 'price'], changes: { name: { from: 'a', to: 'b' }, price: { from: '1', to: '2' } } });
    // The values may only describe a change the field list admits to.
    rejects('PRODUCT_UPDATED', 1, { changedFields: ['name'], changes: { price: { from: '1.00', to: '2.00' } } });
  });

  test('CUSTOMER_UPDATED stores field names only, never values', () => {
    expect(ok('CUSTOMER_UPDATED', 3, { changedFields: ['email', 'phone'] }).details).toEqual({ changedFields: ['email', 'phone'] });
    rejects('CUSTOMER_UPDATED', 3, { changedFields: ['email'], changes: { email: { from: 'a@b.co', to: 'c@d.co' } } });
    rejects('CUSTOMER_UPDATED', 3, { changedFields: ['email'], email: 'ann@example.com' });
    rejects('CUSTOMER_UPDATED', 3, { changedFields: ['password'] });
    rejects('CUSTOMER_UPDATED', 3, { changedFields: [] });
    rejects('CUSTOMER_UPDATED', 3, { name: 'Ann', phone: '555 0100', address: '1 Main St' });
  });

  test('ACCOUNT_PROFILE_UPDATED stores field names only', () => {
    expect(ok('ACCOUNT_PROFILE_UPDATED', 1, { changedFields: ['displayName', 'email'] }).details).toEqual({ changedFields: ['displayName', 'email'] });
    rejects('ACCOUNT_PROFILE_UPDATED', 1, { changedFields: ['password'] });
    rejects('ACCOUNT_PROFILE_UPDATED', 1, { changedFields: ['email'], email: 'new@example.com' });
    rejects('ACCOUNT_PROFILE_UPDATED', 1, { changedFields: ['displayName'], displayName: 'Sam' });
  });

  test('SETTINGS_UPDATED allows only the low-stock threshold, as whole numbers from 0 to 1000', () => {
    expect(ok('SETTINGS_UPDATED', null, { key: 'low_stock_threshold', from: 0, to: 1000 }).details).toEqual({ key: 'low_stock_threshold', from: 0, to: 1000 });
    rejects('SETTINGS_UPDATED', null, { key: 'jwt_secret', from: 1, to: 2 });
    rejects('SETTINGS_UPDATED', null, { key: 'low_stock_threshold', from: 5, to: 1001 });
    rejects('SETTINGS_UPDATED', null, { key: 'low_stock_threshold', from: -1, to: 5 });
    rejects('SETTINGS_UPDATED', null, { key: 'low_stock_threshold', from: 5, to: 5.5 });
    rejects('SETTINGS_UPDATED', null, { key: 'low_stock_threshold', from: '5', to: 6 });
  });
});

describe('sensitive values are refused wherever they are placed', () => {
  // Each sensitive text is tried in every position of every event that takes details: as a value for a field name,
  // as a price, as an extra property, as a property name's value, and as a changedFields entry.
  const placements = (text) => [
    ['PRODUCT_CREATED', { price: text }],
    ['PRODUCT_CREATED', { price: '1.00', sku: text }],
    ['PRODUCT_CREATED', { price: '1.00', name: text }],
    ['PRODUCT_CREATED', { price: '1.00', note: text }],
    ['PRODUCT_UPDATED', { changedFields: [text] }],
    ['PRODUCT_UPDATED', { changedFields: ['price'], changes: { price: { from: text, to: '1.00' } } }],
    ['PRODUCT_UPDATED', { changedFields: ['price'], changes: { price: { from: '1.00', to: text } } }],
    ['PRODUCT_UPDATED', { changedFields: ['name'], changes: { name: { from: 'a', to: text } } }],
    ['PRODUCT_UPDATED', { changedFields: ['price'], note: text }],
    ['CUSTOMER_UPDATED', { changedFields: [text] }],
    ['CUSTOMER_UPDATED', { changedFields: ['name'], note: text }],
    ['ACCOUNT_PROFILE_UPDATED', { changedFields: [text] }],
    ['ACCOUNT_PROFILE_UPDATED', { changedFields: ['email'], email: text }],
    ['SETTINGS_UPDATED', { key: text, from: 1, to: 2 }],
    ['SETTINGS_UPDATED', { key: 'low_stock_threshold', from: text, to: 2 }],
    ['SETTINGS_UPDATED', { key: 'low_stock_threshold', from: 1, to: 2, note: text }],
    ['PRODUCT_ACTIVATED', { note: text }],
    ['PRODUCT_ACTIVATED', text],
    ['CUSTOMER_CREATED', { note: text }],
    ['ACCOUNT_PASSWORD_CHANGED', { password: text }],
    ['ACCOUNT_PASSWORD_CHANGED', text],
  ];

  test.each(SENSITIVE_TEXTS)('%s is refused in every position', (text) => {
    for (const [eventType, details] of placements(text)) {
      expect(() => validateAuditEvent({ eventType, entityId: eventType.startsWith('SETTINGS') ? null : 1, details })).toThrow(AuditValidationError);
    }
  });

  test('a refused event stores nothing and returns nothing: there is no "cleaned" fallback', () => {
    let result = 'untouched';
    try {
      result = ok('PRODUCT_UPDATED', 1, { changedFields: ['name'], changes: { name: { from: 'a', to: JWT } } });
    } catch (err) {
      expect(err).toBeInstanceOf(AuditValidationError);
    }
    expect(result).toBe('untouched');
  });
});

describe('raw request bodies and unknown properties are never accepted', () => {
  test.each([
    ['a login-style body', { email: 'a@b.co', password: 'secret-password-1' }],
    ['a product create body', { sku: 'SKU-1', name: 'USB Hub', price: '1.00', stockQuantity: 3 }],
    ['a customer body', { name: 'Ann', email: 'ann@example.com', phone: '555 0100', address: '1 Main St' }],
    ['a body with a password', { changedFields: ['email'], password: 'secret-password-1' }],
    ['a body with a hash', { changedFields: ['email'], passwordHash: BCRYPT }],
    ['a body with a token', { changedFields: ['email'], token: JWT }],
    ['an array', ['sku', 'name']],
    ['a string', 'sku changed'],
    ['a number', 7],
  ])('%s is refused for every event that takes details, and for events that take none', (_label, body) => {
    for (const type of ['PRODUCT_CREATED', 'PRODUCT_UPDATED', 'CUSTOMER_UPDATED', 'ACCOUNT_PROFILE_UPDATED']) rejects(type, 1, body);
    rejects('SETTINGS_UPDATED', null, body);
    for (const type of ['PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED', 'CUSTOMER_CREATED', 'CUSTOMER_ACTIVATED', 'CUSTOMER_DEACTIVATED', 'ACCOUNT_PASSWORD_CHANGED']) rejects(type, 1, body);
  });

  test('nested objects, functions and class instances are refused', () => {
    rejects('CUSTOMER_UPDATED', 1, { changedFields: ['name'], nested: { a: 1 } });
    rejects('CUSTOMER_UPDATED', 1, { changedFields: ['name'], run: () => 1 });
    rejects('CUSTOMER_UPDATED', 1, new (class Body { constructor() { this.changedFields = ['name']; this.email = 'x@y.co'; } })());
  });

  test('prototype tricks do not smuggle properties through: a __proto__ property is refused like any unknown one', () => {
    const polluted = JSON.parse('{"changedFields":["name"],"__proto__":{"email":"ann@example.com"}}');
    expect(Object.keys(polluted)).toContain('__proto__'); // JSON.parse makes it an ordinary own property
    rejects('CUSTOMER_UPDATED', 1, polluted);
    rejects('PRODUCT_UPDATED', 1, JSON.parse('{"changedFields":["price"],"constructor":{"x":1}}'));
  });
});

describe('what can be stored is only ever a field name, a digits-only price, or the setting key', () => {
  // Every value the schemas accept, for every event, with the largest and the smallest forms.
  const accepted = [
    ['PRODUCT_CREATED', 1, { price: '99999999.99' }],
    ['PRODUCT_CREATED', 1, { price: '0' }],
    ['PRODUCT_UPDATED', 1, { changedFields: ['sku', 'name', 'price'], changes: { price: { from: '0.01', to: '99999999.99' } } }],
    ['PRODUCT_UPDATED', 1, { changedFields: ['sku'] }],
    ['PRODUCT_UPDATED', 1, { changedFields: ['name'] }],
    ['PRODUCT_ACTIVATED', 1, null],
    ['PRODUCT_DEACTIVATED', 1, null],
    ['CUSTOMER_CREATED', 1, null],
    ['CUSTOMER_UPDATED', 1, { changedFields: ['name', 'email', 'phone', 'address'] }],
    ['CUSTOMER_ACTIVATED', 1, null],
    ['CUSTOMER_DEACTIVATED', 1, null],
    ['ACCOUNT_PROFILE_UPDATED', 1, { changedFields: ['displayName', 'email'] }],
    ['ACCOUNT_PASSWORD_CHANGED', 1, null],
    ['SETTINGS_UPDATED', null, { key: 'low_stock_threshold', from: 0, to: 1000 }],
  ];
  const FIELD_NAMES = new Set(['sku', 'name', 'price', 'email', 'phone', 'address', 'displayName']);
  const PRICE = /^\d{1,8}(\.\d{1,2})?$/;

  const strings = (value, found = []) => {
    if (typeof value === 'string') found.push(value);
    else if (Array.isArray(value)) value.forEach((v) => strings(v, found));
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, found));
    return found;
  };

  test('every string in every accepted event is a fixed field name, a digits-only price, or the setting key', () => {
    for (const [eventType, entityId, details] of accepted) {
      for (const text of strings(ok(eventType, entityId, details).details)) {
        const safe = FIELD_NAMES.has(text) || PRICE.test(text) || text === 'low_stock_threshold';
        expect({ eventType, text, safe }).toEqual({ eventType, text, safe: true });
      }
    }
  });

  test('every key in every accepted event is on the fixed list of property names', () => {
    const KEYS = new Set(['price', 'changedFields', 'changes', 'from', 'to', 'key']);
    const keys = (value, found = []) => {
      if (Array.isArray(value)) value.forEach((v) => keys(v, found));
      else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => { found.push(k); keys(v, found); });
      return found;
    };
    for (const [eventType, entityId, details] of accepted) {
      for (const key of keys(ok(eventType, entityId, details).details)) expect({ eventType, key, known: KEYS.has(key) }).toEqual({ eventType, key, known: true });
    }
  });

  test('no schema can store free text: the property names across all schemas are exactly the fixed set', () => {
    const names = new Set();
    const walk = (schema) => {
      const def = schema && schema._zod && schema._zod.def;
      if (!def) return;
      if (def.shape) Object.entries(def.shape).forEach(([key, value]) => { names.add(key); walk(value); });
      if (def.innerType) walk(def.innerType);
      if (def.element) walk(def.element);
      if (def.in) walk(def.in);
    };
    Object.values(DETAIL_SCHEMAS).forEach(walk);
    expect([...names].sort()).toEqual(['changedFields', 'changes', 'from', 'key', 'price', 'to']);
    expect([...names].join(' ')).not.toMatch(/password|hash|token|secret|phone|email|address|name|sku/i);
  });

  test('the stored details are the same shape after a round trip through JSON (nothing hidden in prototypes or undefined)', () => {
    for (const [eventType, entityId, details] of accepted) {
      const stored = ok(eventType, entityId, details).details;
      expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);
    }
  });

  test('the size cap is not needed by any valid event: the largest accepted details are tiny', () => {
    for (const [eventType, entityId, details] of accepted) {
      const stored = ok(eventType, entityId, details).details;
      if (stored) expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThan(300);
    }
  });
});
