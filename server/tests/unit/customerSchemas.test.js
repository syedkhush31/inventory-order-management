// Validation rules for customers. Pure schema tests: no database, no HTTP.
const {
  customerListQuerySchema,
  createCustomerSchema,
  updateCustomerSchema,
  customerIdSchema,
} = require('../../src/validation/customerSchemas');

const valid = { name: 'Ann Lee', email: 'ann@example.com', phone: '+1 (555) 010-2000', address: '1 Main St, Springfield' };
const create = (overrides) => createCustomerSchema.safeParse({ ...valid, ...overrides });
const fieldsOf = (result) => [...new Set(result.error.issues.map((i) => (i.keys ? i.keys.join(',') : i.path.join('.'))))];

describe('createCustomerSchema', () => {
  test('accepts a complete customer unchanged', () => {
    const result = create({});
    expect(result.success).toBe(true);
    expect(result.data).toEqual(valid);
  });

  test('phone and address are optional and default to null', () => {
    const result = createCustomerSchema.safeParse({ name: 'Ann', email: 'ann@example.com' });
    expect(result.data).toEqual({ name: 'Ann', email: 'ann@example.com', phone: null, address: null });
  });

  test('blank or null phone/address are stored as null', () => {
    expect(create({ phone: '   ', address: '' }).data).toMatchObject({ phone: null, address: null });
    expect(create({ phone: null, address: null }).data).toMatchObject({ phone: null, address: null });
  });

  test('trims text and lower-cases the email', () => {
    const result = create({ name: '  Ann Lee ', email: '  ANN@Example.COM ', address: '  1 Main St  ' });
    expect(result.data).toMatchObject({ name: 'Ann Lee', email: 'ann@example.com', address: '1 Main St' });
  });

  test('accepts the boundary lengths', () => {
    expect(create({ name: 'n'.repeat(255) }).success).toBe(true);
    expect(create({ email: `${'a'.repeat(243)}@example.com` }).success).toBe(true); // 255 characters
    expect(create({ phone: '1'.repeat(32) }).success).toBe(true);
    expect(create({ address: 'a'.repeat(500) }).success).toBe(true);
  });

  test.each([
    ['missing name', { name: undefined }, 'name'],
    ['blank name', { name: '   ' }, 'name'],
    ['name of 256 characters', { name: 'n'.repeat(256) }, 'name'],
    ['name with a control character', { name: 'a\u0000b' }, 'name'],
    ['missing email', { email: undefined }, 'email'],
    ['email without @', { email: 'ann.example.com' }, 'email'],
    ['email without a domain', { email: 'ann@' }, 'email'],
    ['email with a space', { email: 'a nn@example.com' }, 'email'],
    ['email of 256 characters', { email: `${'a'.repeat(244)}@example.com` }, 'email'],
    ['phone with letters', { phone: '555-CALL-NOW' }, 'phone'],
    ['phone with too few digits', { phone: '+1' }, 'phone'],
    ['phone of 33 characters', { phone: '1'.repeat(33) }, 'phone'],
    ['numeric phone', { phone: 5550102000 }, 'phone'],
    ['address of 501 characters', { address: 'a'.repeat(501) }, 'address'],
    ['address with a newline', { address: 'line1\nline2' }, 'address'],
    ['non-string name', { name: 42 }, 'name'],
  ])('rejects %s', (_label, overrides, field) => {
    const result = create(overrides);
    expect(result.success).toBe(false);
    expect(fieldsOf(result)).toEqual([field]);
  });

  test.each(['id', 'isActive', 'createdAt', 'updatedAt'])('rejects the unknown property %s', (key) => {
    const result = create({ [key]: 1 });
    expect(result.success).toBe(false);
    expect(fieldsOf(result)).toEqual([key]);
  });

  test('rejects non-object bodies', () => {
    expect(createCustomerSchema.safeParse(null).success).toBe(false);
    expect(createCustomerSchema.safeParse('x').success).toBe(false);
    expect(createCustomerSchema.safeParse([]).success).toBe(false);
  });
});

describe('updateCustomerSchema', () => {
  test('accepts any single field and keeps only what was sent', () => {
    expect(updateCustomerSchema.safeParse({ name: ' New ' }).data).toEqual({ name: 'New' });
    expect(updateCustomerSchema.safeParse({ email: 'NEW@x.io' }).data).toEqual({ email: 'new@x.io' });
    expect(updateCustomerSchema.safeParse({ phone: '555 1234' }).data).toEqual({ phone: '555 1234' });
    expect(updateCustomerSchema.safeParse({ address: 'Elsewhere' }).data).toEqual({ address: 'Elsewhere' });
  });

  test('"" or null clears phone and address (they become null), but not name or email', () => {
    expect(updateCustomerSchema.safeParse({ phone: '' }).data).toEqual({ phone: null });
    expect(updateCustomerSchema.safeParse({ address: null }).data).toEqual({ address: null });
    expect(updateCustomerSchema.safeParse({ name: '' }).success).toBe(false);
    expect(updateCustomerSchema.safeParse({ email: null }).success).toBe(false);
  });

  test('rejects an empty body, and an explicit undefined does not count as a change', () => {
    const result = updateCustomerSchema.safeParse({});
    expect(result.success).toBe(false);
    expect(fieldsOf(result)).toEqual(['body']);
    expect(updateCustomerSchema.safeParse({ name: undefined }).success).toBe(false);
  });

  test.each(['isActive', 'id', 'createdAt'])('rejects %s (it has its own route or cannot be set)', (key) => {
    const result = updateCustomerSchema.safeParse({ name: 'ok', [key]: true });
    expect(result.success).toBe(false);
    expect(fieldsOf(result)).toEqual([key]);
  });

  test.each([
    ['bad email', { email: 'nope' }, 'email'],
    ['bad phone', { phone: 'abc' }, 'phone'],
    ['long address', { address: 'a'.repeat(501) }, 'address'],
  ])('rejects %s', (_label, body, field) => {
    const result = updateCustomerSchema.safeParse(body);
    expect(result.success).toBe(false);
    expect(fieldsOf(result)).toEqual([field]);
  });
});

describe('customerIdSchema', () => {
  test.each(['1', '42', '999999999999999'])('accepts %s as a number', (value) => {
    expect(customerIdSchema.parse(value)).toBe(Number(value));
  });

  test.each(['0', '-1', '01', '1.5', '1e3', ' 1', 'abc', '', '1000000000000000'])('rejects %p', (value) => {
    expect(customerIdSchema.safeParse(value).success).toBe(false);
  });
});

describe('customerListQuerySchema', () => {
  test('defaults', () => {
    expect(customerListQuerySchema.parse({})).toEqual({
      q: '',
      status: 'active',
      page: 1,
      pageSize: 25,
      sort: 'name',
      order: 'asc',
    });
  });

  test('coerces numbers, trims the search and accepts every allowed sort key', () => {
    const parsed = customerListQuerySchema.parse({ q: '  ann ', page: '2', pageSize: '100', status: 'all', order: 'desc' });
    expect(parsed).toMatchObject({ q: 'ann', page: 2, pageSize: 100, status: 'all', order: 'desc' });
    for (const sort of ['name', 'email', 'createdAt', 'updatedAt']) {
      expect(customerListQuerySchema.safeParse({ sort }).success).toBe(true);
    }
  });

  test.each([
    [{ page: '0' }, 'page'],
    [{ page: '1.5' }, 'page'],
    [{ pageSize: '0' }, 'pageSize'],
    [{ pageSize: '101' }, 'pageSize'],
    [{ status: 'deleted' }, 'status'],
    [{ sort: 'password_hash' }, 'sort'],
    [{ sort: 'name; DROP TABLE customers' }, 'sort'],
    [{ order: 'sideways' }, 'order'],
    [{ q: 'x'.repeat(101) }, 'q'],
  ])('rejects %j', (query, field) => {
    const result = customerListQuerySchema.safeParse(query);
    expect(result.success).toBe(false);
    expect(fieldsOf(result)).toEqual([field]);
  });
});
