const {
  orderListQuerySchema,
  createOrderSchema,
  orderIdSchema,
  MAX_ITEMS_PER_ORDER,
  MAX_QUANTITY_PER_ITEM,
} = require('../../src/validation/orderSchemas');

const GOOD = { customerId: 3, items: [{ productId: 1, quantity: 2 }, { productId: 2, quantity: 1 }] };
const fieldsOf = (result) => result.error.issues.map((issue) => issue.path.join('.'));

describe('createOrderSchema', () => {
  test('accepts a valid order', () => {
    expect(createOrderSchema.parse(GOOD)).toEqual(GOOD);
  });

  test('accepts the boundaries: 1 line, 50 lines, the largest quantity', () => {
    expect(createOrderSchema.safeParse({ customerId: 1, items: [{ productId: 1, quantity: 1 }] }).success).toBe(true);
    const fifty = Array.from({ length: MAX_ITEMS_PER_ORDER }, (_, i) => ({ productId: i + 1, quantity: 1 }));
    expect(createOrderSchema.safeParse({ customerId: 1, items: fifty }).success).toBe(true);
    expect(
      createOrderSchema.safeParse({ customerId: 1, items: [{ productId: 1, quantity: MAX_QUANTITY_PER_ITEM }] }).success
    ).toBe(true);
  });

  test.each([
    ['no items', { ...GOOD, items: [] }],
    ['51 lines', { ...GOOD, items: Array.from({ length: 51 }, (_, i) => ({ productId: i + 1, quantity: 1 })) }],
    ['a duplicate product', { ...GOOD, items: [{ productId: 1, quantity: 1 }, { productId: 1, quantity: 2 }] }],
    ['items missing', { customerId: 1 }],
    ['items not an array', { customerId: 1, items: 'x' }],
    ['customerId missing', { items: GOOD.items }],
    ['customerId zero', { ...GOOD, customerId: 0 }],
    ['customerId negative', { ...GOOD, customerId: -1 }],
    ['customerId fractional', { ...GOOD, customerId: 1.5 }],
    ['customerId as a string', { ...GOOD, customerId: '3' }],
    ['productId zero', { ...GOOD, items: [{ productId: 0, quantity: 1 }] }],
    ['productId as a string', { ...GOOD, items: [{ productId: '1', quantity: 1 }] }],
    ['quantity zero', { ...GOOD, items: [{ productId: 1, quantity: 0 }] }],
    ['quantity negative', { ...GOOD, items: [{ productId: 1, quantity: -2 }] }],
    ['quantity fractional', { ...GOOD, items: [{ productId: 1, quantity: 1.5 }] }],
    ['quantity as a string', { ...GOOD, items: [{ productId: 1, quantity: '2' }] }],
    ['quantity too large', { ...GOOD, items: [{ productId: 1, quantity: MAX_QUANTITY_PER_ITEM + 1 }] }],
    ['quantity missing', { ...GOOD, items: [{ productId: 1 }] }],
    ['null body', null],
  ])('rejects %s', (_label, body) => {
    expect(createOrderSchema.safeParse(body).success).toBe(false);
  });

  test.each(['status', 'totalAmount', 'total_amount', 'id', 'createdAt'])('rejects a client-supplied %s', (key) => {
    const result = createOrderSchema.safeParse({ ...GOOD, [key]: 'x' });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].keys).toEqual([key]);
  });

  test.each(['price', 'unitPrice', 'unit_price', 'lineTotal'])('rejects a client-supplied line %s', (key) => {
    const result = createOrderSchema.safeParse({ ...GOOD, items: [{ productId: 1, quantity: 1, [key]: '0.01' }] });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].keys).toEqual([key]);
  });

  test('a duplicate product is reported against items', () => {
    const result = createOrderSchema.safeParse({ ...GOOD, items: [{ productId: 1, quantity: 1 }, { productId: 1, quantity: 1 }] });
    expect(fieldsOf(result)).toEqual(['items']);
  });
});

describe('orderListQuerySchema', () => {
  test('applies the defaults', () => {
    expect(orderListQuerySchema.parse({})).toEqual({
      q: '',
      status: 'all',
      page: 1,
      pageSize: 25,
      sort: 'createdAt',
      order: 'desc',
    });
  });

  test('coerces and trims the query string', () => {
    expect(orderListQuerySchema.parse({ q: '  #12 ', status: 'PENDING', page: '2', pageSize: '10', sort: 'totalAmount', order: 'asc' })).toEqual({
      q: '#12',
      status: 'PENDING',
      page: 2,
      pageSize: 10,
      sort: 'totalAmount',
      order: 'asc',
    });
  });

  test.each([
    { status: 'pending' },
    { status: 'BOGUS' },
    { page: '0' },
    { page: '1.5' },
    { pageSize: '101' },
    { pageSize: '0' },
    { sort: 'customer_id' },
    { sort: 'id; DROP TABLE orders' },
    { order: 'sideways' },
    { q: 'x'.repeat(101) },
  ])('rejects %j', (query) => {
    expect(orderListQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('orderIdSchema', () => {
  test('accepts a positive whole number', () => {
    expect(orderIdSchema.parse('12')).toBe(12);
  });

  test.each(['0', '-1', '1.5', 'abc', '012', '1234567890123456', ' 1', '1 ', ''])('rejects %j', (id) => {
    expect(orderIdSchema.safeParse(id).success).toBe(false);
  });
});
