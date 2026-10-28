// /api/orders with the repository and the transaction helper mocked: no database is touched. These tests prove
// routing, validation, auth, error mapping, exact money maths and that the order, its lines and its first status
// record are committed or rolled back together. They do NOT prove that MySQL accepts the SQL, how it locks rows
// or what it returns; the SQL text of the real repository is only checked against a fake pool in the last section.
const crypto = require('crypto');

process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.CLIENT_ORIGIN = 'http://localhost:5173';

const mockPoolQuery = jest.fn();
jest.mock('../../src/config/db', () => ({ withTransaction: jest.fn(), getPool: () => ({ query: mockPoolQuery }) }));
jest.mock('../../src/repositories/adminRepository', () => ({
  findByEmail: jest.fn(),
  findById: jest.fn(),
  countAll: jest.fn(),
  create: jest.fn(),
}));
jest.mock('../../src/repositories/orderRepository', () => ({
  list: jest.fn(),
  findById: jest.fn(),
  listItems: jest.fn(),
  listStatusHistory: jest.fn(),
  findCustomerForOrder: jest.fn(),
  findProductsForOrder: jest.fn(),
  insertOrder: jest.fn(),
  insertItems: jest.fn(),
  insertStatusHistory: jest.fn(),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../../src/config/db');
const adminRepository = require('../../src/repositories/adminRepository');
const orderRepository = require('../../src/repositories/orderRepository');
const app = require('../../src/app');

const cookie = () =>
  `admin_token=${jwt.sign({}, process.env.JWT_SECRET, { algorithm: 'HS256', subject: '7', expiresIn: 60 })}`;

const CONNECTION = { name: 'transaction-connection' };
const events = []; // 'begin' | 'commit' | 'rollback'

const T0 = new Date('2026-10-28T09:00:00Z');

const ORDER_ROW = {
  id: 12,
  customer_id: 3,
  customer_name: 'Ann Lee',
  customer_email: 'ann@example.com',
  customer_is_active: 1,
  status: 'PENDING',
  total_amount: '64.97',
  item_count: 2,
  created_at: T0,
  updated_at: T0,
};
const ITEM_ROWS = [
  { id: 1, order_id: 12, product_id: 1, sku: 'SKU-1', product_name: 'Widget', quantity: 3, unit_price: '19.99' },
  { id: 2, order_id: 12, product_id: 2, sku: 'SKU-2', product_name: 'Gadget', quantity: 1, unit_price: '5.00' },
];
const HISTORY_ROWS = [
  { id: 1, order_id: 12, from_status: null, to_status: 'PENDING', changed_by_admin_id: 7, changed_at: T0 },
];

const send = (method, url, body, { withCookie = true } = {}) => {
  const req = request(app)[method](url);
  if (withCookie) req.set('Cookie', cookie());
  return body === undefined ? req : req.send(body);
};

const GOOD = { customerId: 3, items: [{ productId: 1, quantity: 3 }, { productId: 2, quantity: 1 }] };

beforeEach(() => {
  jest.resetAllMocks();
  mockPoolQuery.mockReset();
  events.length = 0;
  adminRepository.findById.mockResolvedValue({ id: 7, email: 'admin@example.com', is_active: 1 });
  // Mimics withTransaction: commit when the callback resolves, roll back and rethrow when it fails.
  db.withTransaction.mockImplementation(async (fn) => {
    events.push('begin');
    try {
      const result = await fn(CONNECTION);
      events.push('commit');
      return result;
    } catch (err) {
      events.push('rollback');
      throw err;
    }
  });
  orderRepository.list.mockResolvedValue({ rows: [ORDER_ROW], total: 1 });
  orderRepository.findById.mockResolvedValue(ORDER_ROW);
  orderRepository.listItems.mockResolvedValue(ITEM_ROWS);
  orderRepository.listStatusHistory.mockResolvedValue(HISTORY_ROWS);
  orderRepository.findCustomerForOrder.mockResolvedValue({ id: 3, is_active: 1 });
  orderRepository.findProductsForOrder.mockResolvedValue([
    { id: 1, price: '19.99', is_active: 1 },
    { id: 2, price: '5.00', is_active: 1 },
  ]);
  orderRepository.insertOrder.mockResolvedValue(12);
  orderRepository.insertItems.mockResolvedValue(undefined);
  orderRepository.insertStatusHistory.mockResolvedValue(undefined);
});

const WRITE_FUNCTIONS = ['insertOrder', 'insertItems', 'insertStatusHistory'];
const nothingWritten = () => WRITE_FUNCTIONS.forEach((name) => expect(orderRepository[name]).not.toHaveBeenCalled());

describe('authentication and same-origin protection', () => {
  const routes = [
    ['get', '/api/orders', undefined],
    ['post', '/api/orders', GOOD],
    ['get', '/api/orders/12', undefined],
  ];

  test.each(routes)('%s %s without a session is 401 and touches nothing', async (method, url, body) => {
    const res = await send(method, url, body, { withCookie: false });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(db.withTransaction).not.toHaveBeenCalled();
    expect(orderRepository.list).not.toHaveBeenCalled();
    expect(orderRepository.findById).not.toHaveBeenCalled();
    nothingWritten();
  });

  test('a cross-site POST is refused with 403 and writes nothing', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', cookie())
      .set('Origin', 'http://evil.example')
      .send(GOOD);
    expect(res.status).toBe(403);
    expect(db.withTransaction).not.toHaveBeenCalled();
    nothingWritten();
  });

  test('a Sec-Fetch-Site: cross-site POST is refused with 403', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', cookie())
      .set('Sec-Fetch-Site', 'cross-site')
      .send(GOOD);
    expect(res.status).toBe(403);
    nothingWritten();
  });

  test('there are no delete, replace or edit routes (status changes have their own routes, see orderTransitions.test.js)', async () => {
    for (const [method, url] of [
      ['delete', '/api/orders/12'],
      ['put', '/api/orders/12'],
      ['patch', '/api/orders/12'],
      ['post', '/api/orders/12/status'],
      ['post', '/api/orders/12/items'],
    ]) {
      const res = await send(method, url, {});
      expect([404, 405]).toContain(res.status);
    }
    nothingWritten();
  });
});

describe('GET /api/orders', () => {
  test('returns the page in the documented shape', async () => {
    const res = await send('get', '/api/orders');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      items: [
        {
          id: 12,
          status: 'PENDING',
          totalAmount: '64.97',
          itemCount: 2,
          customer: { id: 3, name: 'Ann Lee', email: 'ann@example.com' },
          createdAt: '2026-10-28T09:00:00.000Z',
          updatedAt: '2026-10-28T09:00:00.000Z',
        },
      ],
      page: 1,
      pageSize: 25,
      total: 1,
      totalPages: 1,
    });
  });

  test('passes the defaults to the repository', async () => {
    await send('get', '/api/orders');
    expect(orderRepository.list).toHaveBeenCalledWith({
      q: '',
      status: 'all',
      page: 1,
      pageSize: 25,
      sort: 'createdAt',
      order: 'desc',
    });
  });

  test('passes search, status, sort and paging through', async () => {
    orderRepository.list.mockResolvedValue({ rows: [], total: 51 });
    const res = await send('get', '/api/orders?q=%2312&status=CONFIRMED&page=2&pageSize=20&sort=totalAmount&order=asc');
    expect(res.status).toBe(200);
    expect(orderRepository.list).toHaveBeenCalledWith({
      q: '#12',
      status: 'CONFIRMED',
      page: 2,
      pageSize: 20,
      sort: 'totalAmount',
      order: 'asc',
    });
    expect(res.body).toMatchObject({ items: [], page: 2, pageSize: 20, total: 51, totalPages: 3 });
  });

  test.each(['status=bogus', 'sort=customer_id', 'pageSize=500', 'page=0', 'order=up'])('rejects ?%s with 400', async (qs) => {
    const res = await send('get', `/api/orders?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
    expect(orderRepository.list).not.toHaveBeenCalled();
  });

  test('a database failure is a generic 500 without details', async () => {
    orderRepository.list.mockRejectedValue(Object.assign(new Error('SELECT secret FROM x'), { code: 'ER_X' }));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await send('get', '/api/orders');
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});

describe('GET /api/orders/:id', () => {
  test('returns the order with customer, price snapshots and status history', async () => {
    const res = await send('get', '/api/orders/12');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      order: {
        id: 12,
        status: 'PENDING',
        totalAmount: '64.97',
        customer: { id: 3, name: 'Ann Lee', email: 'ann@example.com', isActive: true },
        items: [
          { id: 1, productId: 1, sku: 'SKU-1', productName: 'Widget', quantity: 3, unitPrice: '19.99', lineTotal: '59.97' },
          { id: 2, productId: 2, sku: 'SKU-2', productName: 'Gadget', quantity: 1, unitPrice: '5.00', lineTotal: '5.00' },
        ],
        statusHistory: [{ id: 1, fromStatus: null, toStatus: 'PENDING', changedByAdminId: 7, changedAt: '2026-10-28T09:00:00.000Z' }],
        createdAt: '2026-10-28T09:00:00.000Z',
        updatedAt: '2026-10-28T09:00:00.000Z',
      },
    });
    expect(orderRepository.findById).toHaveBeenCalledWith(12);
    expect(orderRepository.listItems).toHaveBeenCalledWith(12);
    expect(orderRepository.listStatusHistory).toHaveBeenCalledWith(12);
  });

  test('uses the saved unit price for the line total, not a current product price', async () => {
    orderRepository.listItems.mockResolvedValue([{ ...ITEM_ROWS[0], quantity: 2, unit_price: '0.10' }]);
    const res = await send('get', '/api/orders/12');
    expect(res.body.order.items[0]).toMatchObject({ unitPrice: '0.10', lineTotal: '0.20' });
    expect(orderRepository.findProductsForOrder).not.toHaveBeenCalled();
  });

  test('an unknown order is 404', async () => {
    orderRepository.findById.mockResolvedValue(null);
    const res = await send('get', '/api/orders/999');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Order not found' });
  });

  test.each(['0', 'abc', '-3', '1.5', '1234567890123456'])('an invalid id %s is 400', async (id) => {
    const res = await send('get', `/api/orders/${id}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', fields: ['id'] });
    expect(orderRepository.findById).not.toHaveBeenCalled();
  });
});

describe('POST /api/orders: success', () => {
  test('creates a PENDING order and returns it with 201', async () => {
    const res = await send('post', '/api/orders', GOOD);
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.order).toMatchObject({
      id: 12,
      status: 'PENDING',
      totalAmount: '64.97',
      customer: { id: 3 },
    });
    expect(res.body.order.items).toHaveLength(2);
  });

  test('everything is written on the transaction connection, then committed once', async () => {
    await send('post', '/api/orders', GOOD);
    expect(events).toEqual(['begin', 'commit']);
    expect(orderRepository.findCustomerForOrder).toHaveBeenCalledWith(CONNECTION, 3);
    expect(orderRepository.findProductsForOrder).toHaveBeenCalledWith(CONNECTION, [1, 2]);
    expect(orderRepository.insertOrder).toHaveBeenCalledWith(CONNECTION, { customerId: 3, totalAmount: '64.97' });
    expect(orderRepository.insertItems).toHaveBeenCalledWith(CONNECTION, 12, [
      { productId: 1, quantity: 3, unitPrice: '19.99' },
      { productId: 2, quantity: 1, unitPrice: '5.00' },
    ]);
    expect(orderRepository.insertStatusHistory).toHaveBeenCalledWith(CONNECTION, {
      orderId: 12,
      fromStatus: null,
      toStatus: 'PENDING',
      adminId: 7,
    });
  });

  test('the order is inserted before its lines and its status record', async () => {
    const calls = [];
    orderRepository.insertOrder.mockImplementation(async () => (calls.push('order'), 12));
    orderRepository.insertItems.mockImplementation(async () => calls.push('items'));
    orderRepository.insertStatusHistory.mockImplementation(async () => calls.push('history'));
    await send('post', '/api/orders', GOOD);
    expect(calls).toEqual(['order', 'items', 'history']);
  });

  test('prices come from the database, and the order is read back only after the commit', async () => {
    orderRepository.findById.mockImplementation(async () => {
      expect(events).toEqual(['begin', 'commit']);
      return ORDER_ROW;
    });
    await send('post', '/api/orders', GOOD);
    expect(orderRepository.findById).toHaveBeenCalledWith(12);
  });

  test('stock is never touched (no stock queries exist on the order repository)', async () => {
    await send('post', '/api/orders', GOOD);
    expect(Object.keys(orderRepository).filter((name) => /stock/i.test(name))).toEqual([]);
  });

  test('the total is exact: 0.10 x 3 + 0.20 x 1 is 0.50, not 0.5000000000000001', async () => {
    orderRepository.findProductsForOrder.mockResolvedValue([
      { id: 1, price: '0.10', is_active: 1 },
      { id: 2, price: '0.20', is_active: 1 },
    ]);
    await send('post', '/api/orders', { customerId: 3, items: [{ productId: 1, quantity: 3 }, { productId: 2, quantity: 1 }] });
    expect(orderRepository.insertOrder).toHaveBeenCalledWith(CONNECTION, { customerId: 3, totalAmount: '0.50' });
  });

  test('a free product (0.00) is allowed and an all-free order totals 0.00', async () => {
    orderRepository.findProductsForOrder.mockResolvedValue([{ id: 1, price: '0.00', is_active: 1 }]);
    const res = await send('post', '/api/orders', { customerId: 3, items: [{ productId: 1, quantity: 5 }] });
    expect(res.status).toBe(201);
    expect(orderRepository.insertOrder).toHaveBeenCalledWith(CONNECTION, { customerId: 3, totalAmount: '0.00' });
  });

  test('the largest allowed total, exactly 9999999999.99, is accepted', async () => {
    // 99999999.99 x 100 = 9999999999.00, plus 0.99 x 1 = 9999999999.99: the DECIMAL(12,2) maximum, to the cent.
    orderRepository.findProductsForOrder.mockResolvedValue([
      { id: 1, price: '99999999.99', is_active: 1 },
      { id: 2, price: '0.99', is_active: 1 },
    ]);
    const res = await send('post', '/api/orders', {
      customerId: 3,
      items: [{ productId: 1, quantity: 100 }, { productId: 2, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    expect(orderRepository.insertOrder).toHaveBeenCalledWith(CONNECTION, { customerId: 3, totalAmount: '9999999999.99' });
  });

  test('one cent above the maximum (10000000000.00) is refused and nothing is written', async () => {
    // 99999999.99 x 100 = 9999999999.00, plus 1.00 x 1 = 10000000000.00
    orderRepository.findProductsForOrder.mockResolvedValue([
      { id: 1, price: '99999999.99', is_active: 1 },
      { id: 2, price: '1.00', is_active: 1 },
    ]);
    const res = await send('post', '/api/orders', {
      customerId: 3,
      items: [{ productId: 1, quantity: 100 }, { productId: 2, quantity: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'The order total is too large', fields: ['items'] });
    expect(events).toEqual(['begin', 'rollback']);
    nothingWritten();
  });

  test('line order follows the request, even if the database returns products in another order', async () => {
    orderRepository.findProductsForOrder.mockResolvedValue([
      { id: 1, price: '19.99', is_active: 1 },
      { id: 2, price: '5.00', is_active: 1 },
    ]);
    await send('post', '/api/orders', { customerId: 3, items: [{ productId: 2, quantity: 1 }, { productId: 1, quantity: 3 }] });
    expect(orderRepository.insertItems.mock.calls[0][2].map((line) => line.productId)).toEqual([2, 1]);
  });
});

describe('POST /api/orders: validation', () => {
  test.each([
    ['no items', { customerId: 3, items: [] }, ['items']],
    ['a duplicate product', { customerId: 3, items: [{ productId: 1, quantity: 1 }, { productId: 1, quantity: 1 }] }, ['items']],
    ['quantity zero', { customerId: 3, items: [{ productId: 1, quantity: 0 }] }, ['items.0.quantity']],
    ['a fractional quantity', { customerId: 3, items: [{ productId: 1, quantity: 1.5 }] }, ['items.0.quantity']],
    ['a missing customer', { items: [{ productId: 1, quantity: 1 }] }, ['customerId']],
    ['a client-supplied price', { customerId: 3, items: [{ productId: 1, quantity: 1, price: '0.01' }] }, ['price']],
    ['a client-supplied total', { ...GOOD, totalAmount: '0.01' }, ['totalAmount']],
    ['a client-supplied status', { ...GOOD, status: 'CONFIRMED' }, ['status']],
  ])('%s is 400 and nothing is written', async (_label, body, fields) => {
    const res = await send('post', '/api/orders', body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', fields });
    expect(db.withTransaction).not.toHaveBeenCalled();
    nothingWritten();
  });

  test('an empty body is 400', async () => {
    const res = await send('post', '/api/orders', {});
    expect(res.status).toBe(400);
    nothingWritten();
  });
});

describe('POST /api/orders: business rules (nothing is committed)', () => {
  const rolledBackWithNothingWritten = () => {
    expect(events).toEqual(['begin', 'rollback']);
    nothingWritten();
  };

  test('an unknown customer is 400', async () => {
    orderRepository.findCustomerForOrder.mockResolvedValue(null);
    const res = await send('post', '/api/orders', GOOD);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Customer not found', fields: ['customerId'] });
    rolledBackWithNothingWritten();
    expect(orderRepository.findProductsForOrder).not.toHaveBeenCalled();
  });

  test('an inactive customer is 409', async () => {
    orderRepository.findCustomerForOrder.mockResolvedValue({ id: 3, is_active: 0 });
    const res = await send('post', '/api/orders', GOOD);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Customer is inactive', fields: ['customerId'] });
    rolledBackWithNothingWritten();
  });

  test('an unknown product is 400 and names the product', async () => {
    orderRepository.findProductsForOrder.mockResolvedValue([{ id: 1, price: '19.99', is_active: 1 }]);
    const res = await send('post', '/api/orders', GOOD);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Some products do not exist', fields: ['items'], productIds: [2] });
    rolledBackWithNothingWritten();
  });

  test('an inactive product is 409 and names the product', async () => {
    orderRepository.findProductsForOrder.mockResolvedValue([
      { id: 1, price: '19.99', is_active: 1 },
      { id: 2, price: '5.00', is_active: 0 },
    ]);
    const res = await send('post', '/api/orders', GOOD);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Some products are inactive', fields: ['items'], productIds: [2] });
    rolledBackWithNothingWritten();
  });

  test('a total above the DECIMAL(12,2) limit is 400', async () => {
    orderRepository.findProductsForOrder.mockResolvedValue([
      { id: 1, price: '99999999.99', is_active: 1 },
      { id: 2, price: '5.00', is_active: 1 },
    ]);
    const res = await send('post', '/api/orders', {
      customerId: 3,
      items: [{ productId: 1, quantity: 100 }, { productId: 2, quantity: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'The order total is too large', fields: ['items'] });
    rolledBackWithNothingWritten();
  });

  test('stock levels are not part of order creation: a product with no stock can still be ordered', async () => {
    orderRepository.findProductsForOrder.mockResolvedValue([
      { id: 1, price: '19.99', is_active: 1, stock_quantity: 0 },
      { id: 2, price: '5.00', is_active: 1, stock_quantity: 0 },
    ]);
    const res = await send('post', '/api/orders', GOOD);
    expect(res.status).toBe(201);
  });
});

describe('POST /api/orders: rollback on failure', () => {
  const boom = () => Object.assign(new Error('INSERT secret'), { code: 'ER_BOOM' });

  test.each([
    ['inserting the order', 'insertOrder', 0],
    ['inserting the lines', 'insertItems', 1],
    ['inserting the status record', 'insertStatusHistory', 2],
  ])('a failure while %s rolls everything back and answers a generic 500', async (_label, failing) => {
    orderRepository[failing].mockRejectedValue(boom());
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await send('post', '/api/orders', GOOD);
    spy.mockRestore();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toMatch(/INSERT|secret|ER_BOOM/);
    expect(events).toEqual(['begin', 'rollback']);
    expect(orderRepository.findById).not.toHaveBeenCalled(); // never reads back an order that was not committed
  });

  // The order is already committed when the read-back runs, so the answer must not be an error: a retry would
  // create a second order. The response says plainly that the details are missing.
  describe('the order is saved but cannot be read back', () => {
    const readFailures = [
      ['the order row', () => orderRepository.findById],
      ['its lines', () => orderRepository.listItems],
      ['its status history', () => orderRepository.listStatusHistory],
    ];

    test.each(readFailures)('a failure reading %s still answers 201, without an order, and nothing is repeated', async (_label, pick) => {
      pick().mockRejectedValue(Object.assign(new Error("SELECT email FROM customers WHERE name = 'Ann Lee'"), { code: 'ER_BOOM' }));
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const res = await send('post', '/api/orders', GOOD);
      const logged = spy.mock.calls.map((call) => call.join(' ')).join('\n');
      spy.mockRestore();

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        order: null,
        orderId: 12,
        status: 'PENDING',
        totalAmount: '64.97',
        detailsAvailable: false,
        message:
          'Order #12 was created, but its details could not be loaded. Do not submit it again; find it in the orders list.',
      });
      // One transaction, committed once; every write happened exactly once and is never retried.
      expect(db.withTransaction).toHaveBeenCalledTimes(1);
      expect(events).toEqual(['begin', 'commit']);
      expect(orderRepository.insertOrder).toHaveBeenCalledTimes(1);
      expect(orderRepository.insertItems).toHaveBeenCalledTimes(1);
      expect(orderRepository.insertStatusHistory).toHaveBeenCalledTimes(1);
      // The reply carries no customer data, no product data and no database message.
      expect(JSON.stringify(res.body)).not.toMatch(/Ann Lee|ann@example|SELECT|ER_BOOM|Widget/);
      // Only a short category is logged: the order number and the error code, never the message or customer data.
      expect(logged).toBe('Order 12 was saved but could not be read back: ER_BOOM');
    });

    test('an error without a code is logged by its name only', async () => {
      orderRepository.findById.mockRejectedValue(new TypeError('Cannot read properties of undefined (email)'));
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const res = await send('post', '/api/orders', GOOD);
      const logged = spy.mock.calls.map((call) => call.join(' ')).join('\n');
      spy.mockRestore();
      expect(res.status).toBe(201);
      expect(logged).toBe('Order 12 was saved but could not be read back: TypeError');
    });

    test('a normal creation still returns the full order and no placeholder fields', async () => {
      const res = await send('post', '/api/orders', GOOD);
      expect(res.status).toBe(201);
      expect(Object.keys(res.body)).toEqual(['order']);
      expect(res.body.order).not.toBeNull();
    });
  });

  test('a failure looking up the customer or products rolls back and writes nothing', async () => {
    orderRepository.findProductsForOrder.mockRejectedValue(boom());
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await send('post', '/api/orders', GOOD);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(events).toEqual(['begin', 'rollback']);
    nothingWritten();
  });
});

// ---- The real repository against a fake pool / connection: checks the SQL text and parameters only ----
describe('orderRepository SQL (real repository, fake pool)', () => {
  const real = jest.requireActual('../../src/repositories/orderRepository');
  const sqlOf = (mock, index = 0) => mock.mock.calls[index][0].replace(/\s+/g, ' ');

  beforeEach(() => {
    mockPoolQuery.mockImplementation(async (sql) => (/COUNT\(\*\)/.test(sql) ? [[{ total: 0 }]] : [[]]));
  });

  test('list with no filters has no WHERE and uses the default whitelisted sort', async () => {
    await real.list({ q: '', status: 'all', sort: 'createdAt', order: 'desc', page: 1, pageSize: 25 });
    const [count, select] = mockPoolQuery.mock.calls;
    expect(count[0]).not.toMatch(/WHERE/);
    expect(count[1]).toEqual([]);
    expect(sqlOf(mockPoolQuery, 1)).toContain('ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?');
    expect(select[1]).toEqual([25, 0]);
  });

  test('a numeric search matches the order id as well as customer name and email', async () => {
    await real.list({ q: '#12', status: 'all', sort: 'id', order: 'asc', page: 3, pageSize: 10 });
    const [, select] = mockPoolQuery.mock.calls;
    expect(sqlOf(mockPoolQuery, 1)).toContain(
      "WHERE (c.name LIKE ? ESCAPE '!' OR c.email LIKE ? ESCAPE '!' OR o.id = ?)"
    );
    expect(select[1]).toEqual(['%#12%', '%#12%', 12, 10, 20]);
    expect(sqlOf(mockPoolQuery, 1)).toContain('ORDER BY o.id ASC, o.id ASC');
  });

  test('a text search does not add the id condition, and LIKE wildcards are escaped', async () => {
    await real.list({ q: '50%_off!', status: 'all', sort: 'customerName', order: 'asc', page: 1, pageSize: 25 });
    const [, select] = mockPoolQuery.mock.calls;
    expect(sqlOf(mockPoolQuery, 1)).not.toContain('o.id = ?');
    expect(select[1].slice(0, 2)).toEqual(['%50!%!_off!!%', '%50!%!_off!!%']);
    expect(sqlOf(mockPoolQuery, 1)).toContain('ORDER BY c.name ASC');
  });

  test('the status filter is a placeholder, and combines with the search using AND', async () => {
    await real.list({ q: 'ann', status: 'PENDING', sort: 'totalAmount', order: 'desc', page: 1, pageSize: 25 });
    const [, select] = mockPoolQuery.mock.calls;
    expect(sqlOf(mockPoolQuery, 1)).toContain(') AND o.status = ?');
    expect(select[1]).toEqual(['%ann%', '%ann%', 'PENDING', 25, 0]);
  });

  test('user input never appears in the SQL text', async () => {
    await real.list({ q: "x' OR 1=1 --", status: 'all', sort: 'createdAt', order: 'desc', page: 1, pageSize: 25 });
    for (const [sql] of mockPoolQuery.mock.calls) expect(sql).not.toContain('OR 1=1');
  });

  test('an unsupported sort key throws before any query runs', async () => {
    await expect(
      real.list({ q: '', status: 'all', sort: 'id; DROP TABLE orders', order: 'asc', page: 1, pageSize: 25 })
    ).rejects.toThrow('Unsupported sort key');
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  test('the item query reads the saved snapshot column order_items.unit_price', async () => {
    await real.listItems(12);
    expect(sqlOf(mockPoolQuery)).toContain('oi.unit_price');
    expect(sqlOf(mockPoolQuery)).not.toMatch(/p\.price/);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([12]);
  });

  test('the history query is oldest first', async () => {
    await real.listStatusHistory(12);
    expect(sqlOf(mockPoolQuery)).toContain('ORDER BY changed_at ASC, id ASC');
  });

  test('the transaction helpers use the connection given, with shared locks in id order', async () => {
    const connection = { query: jest.fn().mockResolvedValue([[]]) };
    await real.findCustomerForOrder(connection, 3);
    await real.findProductsForOrder(connection, [5, 1]);
    expect(sqlOf(connection.query, 0)).toContain('FROM customers WHERE id = ? LIMIT 1 FOR SHARE');
    expect(sqlOf(connection.query, 1)).toContain('WHERE id IN (?) ORDER BY id ASC FOR SHARE');
    expect(connection.query.mock.calls[1][1]).toEqual([[5, 1]]);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  test('the inserts use the connection, placeholders, and a PENDING initial record with a NULL from_status', async () => {
    const connection = { query: jest.fn().mockResolvedValue([{ insertId: 12 }]) };
    expect(await real.insertOrder(connection, { customerId: 3, totalAmount: '64.97' })).toBe(12);
    await real.insertItems(connection, 12, [{ productId: 1, quantity: 3, unitPrice: '19.99' }]);
    await real.insertStatusHistory(connection, { orderId: 12, fromStatus: null, toStatus: 'PENDING', adminId: 7 });

    expect(sqlOf(connection.query, 0)).toBe('INSERT INTO orders (customer_id, total_amount) VALUES (?, ?)');
    expect(connection.query.mock.calls[0][1]).toEqual([3, '64.97']);
    expect(sqlOf(connection.query, 1)).toBe('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ?');
    expect(connection.query.mock.calls[1][1]).toEqual([[[12, 1, 3, '19.99']]]);
    expect(connection.query.mock.calls[2][1]).toEqual([12, null, 'PENDING', 7]);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});
