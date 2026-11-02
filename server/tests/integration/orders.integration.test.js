// Orders against the real MySQL TEST database (inventory_test): creating, reading, searching, filtering, sorting,
// paging and moving orders through their statuses. This file WRITES to the test database: every test starts from empty
// tables (resetTestDatabase) and the tables are emptied again afterwards. See tests/helpers/integrationEnv.js for the
// safety guards that refuse to run against anything but inventory_test.
//
// Data is built either through the real API (so behaviour is genuine) or with direct SQL fixtures (to reach states the
// API refuses, or to create many rows quickly). Ids are never hard-coded: tables keep counting upwards between tests.
const { INTEGRATION_TIMEOUT, useIntegrationDatabase } = require('../helpers/integrationEnv');
const f = require('../helpers/factories');
const db = require('../helpers/dbAssert');
const { backdate, minutesAfter } = require('../helpers/clock');
const { assertNoSecrets } = require('../helpers/privacy');

jest.setTimeout(INTEGRATION_TIMEOUT);

const ctx = useIntegrationDatabase();

let cat; // { customer, inactiveCustomer, p1, p2, p3 }, rebuilt before every test
beforeEach(async () => {
  cat = await f.createCatalogue();
});

const WRITE_TABLES = ['orders', 'order_items', 'order_status_history', 'stock_adjustments'];
const NOTHING_WRITTEN = { orders: 0, order_items: 0, order_status_history: 0, stock_adjustments: 0 };

const ids = (res) => res.body.items.map((order) => order.id);
const listUrl = (params) => `/api/orders?${new URLSearchParams({ pageSize: '100', ...params }).toString()}`;

// ------------------------------------------------------------------------------------------------ creating orders
describe('ORD-1 / ORD-2: creating an order', () => {
  test('ORD-1 creates a PENDING order with price snapshots, exact totals and a first history row, and leaves stock alone', async () => {
    const res = await ctx.api.post('/api/orders', {
      customerId: cat.customer.id,
      items: f.lines([cat.p1, 3], [cat.p2, 2]),
    });

    expect(res.status).toBe(201);
    const { order } = res.body;
    expect(order).toMatchObject({
      status: 'PENDING',
      totalAmount: '35.00', // 3 x 10.00 + 2 x 2.50, added up in whole cents
      customer: { id: cat.customer.id, name: 'Ann Example', email: 'ann@example.test', isActive: true },
    });
    expect(order.items).toEqual([
      { id: expect.any(Number), productId: cat.p1.id, sku: 'P-ONE', productName: 'Product One', quantity: 3, unitPrice: '10.00', lineTotal: '30.00' },
      { id: expect.any(Number), productId: cat.p2.id, sku: 'P-TWO', productName: 'Product Two', quantity: 2, unitPrice: '2.50', lineTotal: '5.00' },
    ]);
    expect(order.statusHistory).toEqual([
      { id: expect.any(Number), fromStatus: null, toStatus: 'PENDING', changedByAdminId: ctx.admin.id, changedAt: expect.any(String) },
    ]);

    // What MySQL really holds.
    expect(await db.orderRow(order.id)).toEqual({
      id: order.id,
      customerId: cat.customer.id,
      status: 'PENDING',
      totalAmount: '35.00',
    });
    expect(await db.orderItems(order.id)).toEqual([
      { productId: cat.p1.id, quantity: 3, unitPrice: '10.00' },
      { productId: cat.p2.id, quantity: 2, unitPrice: '2.50' },
    ]);
    expect(await db.orderHistory(order.id)).toEqual([
      { fromStatus: null, toStatus: 'PENDING', changedByAdminId: ctx.admin.id },
    ]);
    expect(await db.countsOf(WRITE_TABLES)).toEqual({ orders: 1, order_items: 2, order_status_history: 1, stock_adjustments: 0 });
    // Creating an order neither checks nor changes stock.
    expect(await db.productStock(cat.p1.id)).toBe(10);
    expect(await db.productStock(cat.p2.id)).toBe(5);
  });

  test('ORD-2 a later price edit does not change an existing order', async () => {
    const order = await f.createOrderViaApi(ctx.api, { customerId: cat.customer.id, items: f.lines([cat.p1, 3]) });

    const edit = await ctx.api.patch(`/api/products/${cat.p1.id}`, { price: '99.00' });
    expect(edit.status).toBe(200);
    expect(edit.body.product.price).toBe('99.00');

    const res = await ctx.api.get(`/api/orders/${order.id}`);
    expect(res.status).toBe(200);
    expect(res.body.order.totalAmount).toBe('30.00');
    expect(res.body.order.items[0]).toMatchObject({ unitPrice: '10.00', lineTotal: '30.00' });
    expect((await db.orderItems(order.id))[0].unitPrice).toBe('10.00');
  });
});

describe('ORD-3: invalid new orders are rejected and nothing is written', () => {
  const validLine = (c) => ({ productId: c.p1.id, quantity: 1 });
  const INVALID = [
    ['no customerId', (c) => ({ items: [validLine(c)] }), ['customerId']],
    ['a customerId given as text', (c) => ({ customerId: String(c.customer.id), items: [validLine(c)] }), ['customerId']],
    ['customerId 0', (c) => ({ customerId: 0, items: [validLine(c)] }), ['customerId']],
    ['no items', (c) => ({ customerId: c.customer.id }), ['items']],
    ['an empty items list', (c) => ({ customerId: c.customer.id, items: [] }), ['items']],
    [
      '51 lines',
      (c) => ({ customerId: c.customer.id, items: Array.from({ length: 51 }, (_, i) => ({ productId: 1000 + i, quantity: 1 })) }),
      ['items'],
    ],
    ['the same product twice', (c) => ({ customerId: c.customer.id, items: [validLine(c), { productId: c.p1.id, quantity: 2 }] }), ['items']],
    ['quantity 0', (c) => ({ customerId: c.customer.id, items: [{ productId: c.p1.id, quantity: 0 }] }), ['items.0.quantity']],
    ['quantity 10001', (c) => ({ customerId: c.customer.id, items: [{ productId: c.p1.id, quantity: 10001 }] }), ['items.0.quantity']],
    ['a fractional quantity', (c) => ({ customerId: c.customer.id, items: [{ productId: c.p1.id, quantity: 1.5 }] }), ['items.0.quantity']],
    ['a quantity given as text', (c) => ({ customerId: c.customer.id, items: [{ productId: c.p1.id, quantity: '2' }] }), ['items.0.quantity']],
    ['product id 0', (c) => ({ customerId: c.customer.id, items: [{ productId: 0, quantity: 1 }] }), ['items.0.productId']],
    ['a price sent on a line', (c) => ({ customerId: c.customer.id, items: [{ productId: c.p1.id, quantity: 1, price: '0.01' }] }), ['price']],
    ['a total sent by the client', (c) => ({ customerId: c.customer.id, items: [validLine(c)], totalAmount: '0.01' }), ['totalAmount']],
    ['a status sent by the client', (c) => ({ customerId: c.customer.id, items: [validLine(c)], status: 'CONFIRMED' }), ['status']],
  ];

  test.each(INVALID)('ORD-3 rejects %s with 400', async (_name, buildBody, expectedFields) => {
    const res = await ctx.api.post('/api/orders', buildBody(cat));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
    expect(res.body.fields).toEqual(expect.arrayContaining(expectedFields));
    expect(await db.countsOf(WRITE_TABLES)).toEqual(NOTHING_WRITTEN);
  });

  test('ORD-3 an unknown customer is a 400 that names customerId', async () => {
    const res = await ctx.api.post('/api/orders', { customerId: cat.p3.id + 100000, items: f.lines([cat.p1, 1]) });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Customer not found', fields: ['customerId'] });
    expect(await db.countsOf(WRITE_TABLES)).toEqual(NOTHING_WRITTEN);
  });

  test('ORD-3 an unknown product is a 400 that lists its id, even next to a valid line', async () => {
    const missingId = cat.p3.id + 100000;
    const res = await ctx.api.post('/api/orders', {
      customerId: cat.customer.id,
      items: [{ productId: cat.p1.id, quantity: 1 }, { productId: missingId, quantity: 1 }],
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Some products do not exist', fields: ['items'], productIds: [missingId] });
    expect(await db.countsOf(WRITE_TABLES)).toEqual(NOTHING_WRITTEN);
  });
});

describe('ORD-4 / ORD-5: inactive customers and products', () => {
  test('ORD-4 an inactive customer is refused with 409', async () => {
    const res = await ctx.api.post('/api/orders', { customerId: cat.inactiveCustomer.id, items: f.lines([cat.p1, 1]) });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'Customer is inactive', fields: ['customerId'] });
    expect(await db.countsOf(WRITE_TABLES)).toEqual(NOTHING_WRITTEN);
  });

  test('ORD-5 an inactive product is refused with 409 and listed in productIds', async () => {
    const res = await ctx.api.post('/api/orders', { customerId: cat.customer.id, items: f.lines([cat.p1, 1], [cat.p3, 1]) });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'Some products are inactive', fields: ['items'], productIds: [cat.p3.id] });
    expect(await db.countsOf(WRITE_TABLES)).toEqual(NOTHING_WRITTEN);
  });
});

describe('ORD-6: the order total limit', () => {
  test('ORD-6 a total above DECIMAL(12,2) is refused with 400 and nothing is written', async () => {
    const huge = await f.createProduct({ sku: 'HUGE', price: '99999999.99', stock: 1 });

    const res = await ctx.api.post('/api/orders', { customerId: cat.customer.id, items: f.lines([huge, 10000]) });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'The order total is too large', fields: ['items'] });
    expect(await db.countsOf(WRITE_TABLES)).toEqual(NOTHING_WRITTEN);
  });

  test('ORD-6 a total exactly at the largest allowed size is accepted', async () => {
    const huge = await f.createProduct({ sku: 'HUGE', price: '99999999.99', stock: 1 });

    // 99,999,999.99 x 100 = 9,999,999,999.00, which still fits in DECIMAL(12,2).
    const res = await ctx.api.post('/api/orders', { customerId: cat.customer.id, items: f.lines([huge, 100]) });

    expect(res.status).toBe(201);
    expect(res.body.order.totalAmount).toBe('9999999999.00');
    expect((await db.orderRow(res.body.order.id)).totalAmount).toBe('9999999999.00');
  });
});

// ----------------------------------------------------------------------------------------------- reading one order
describe('ORD-8 to ORD-10: order details', () => {
  test('ORD-8 returns the customer, the lines in order, the history and no secrets', async () => {
    const created = await f.createOrderViaApi(ctx.api, { customerId: cat.customer.id, items: f.lines([cat.p1, 1], [cat.p2, 4]) });

    const res = await ctx.api.get(`/api/orders/${created.id}`);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.order).toMatchObject({
      id: created.id,
      status: 'PENDING',
      totalAmount: '20.00', // 10.00 + 4 x 2.50
      customer: { id: cat.customer.id, name: 'Ann Example', email: 'ann@example.test', isActive: true },
    });
    expect(res.body.order.items.map((line) => [line.productId, line.quantity, line.unitPrice, line.lineTotal])).toEqual([
      [cat.p1.id, 1, '10.00', '10.00'],
      [cat.p2.id, 4, '2.50', '10.00'],
    ]);
    expect(res.body.order.statusHistory).toHaveLength(1);
    expect(typeof res.body.order.createdAt).toBe('string');
    assertNoSecrets(res.body);
  });

  test('ORD-9 after the customer is deactivated the order still reads fine and shows isActive false', async () => {
    const created = await f.createOrderViaApi(ctx.api, { customerId: cat.customer.id, items: f.lines([cat.p1, 1]) });

    const off = await ctx.api.post(`/api/customers/${cat.customer.id}/deactivate`);
    expect(off.status).toBe(200);

    const res = await ctx.api.get(`/api/orders/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.order.customer).toMatchObject({ id: cat.customer.id, name: 'Ann Example', isActive: false });
  });

  test('ORD-10 an unknown order is 404 and an invalid id is 400', async () => {
    const missing = await ctx.api.get('/api/orders/999999999');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Order not found' });

    for (const bad of ['abc', '0', '-1', '1.5']) {
      const res = await ctx.api.get(`/api/orders/${bad}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'Invalid request', fields: ['id'] });
    }
  });
});

// ------------------------------------------------------------------------- listing: search, filter, sort, paging
describe('ORD-11: searching the order list', () => {
  test('ORD-11 matches customer name and email (any letter case), order numbers, and treats % and _ literally', async () => {
    const alice = await f.createCustomer({ name: 'Alice Anderson', email: 'alice@example.test' });
    const bob = await f.createCustomer({ name: 'Bob Brown', email: 'bob@shop.test' });
    const percent = await f.createCustomer({ name: 'Wild%Card', email: 'wild@example.test' });
    const lookalike = await f.createCustomer({ name: 'Wildxxcard', email: 'plain@example.test' });
    const underscore = await f.createCustomer({ name: 'A_ice Real', email: 'under@example.test' });

    const orderOf = {};
    for (const customer of [alice, bob, percent, lookalike, underscore]) {
      orderOf[customer.name] = (await f.createOrderViaApi(ctx.api, { customerId: customer.id, items: f.lines([cat.p1, 1]) })).id;
    }

    const search = async (q) => ids(await ctx.api.get(listUrl({ q })));

    expect(await search('alice')).toEqual([orderOf['Alice Anderson']]); // letter case does not matter
    expect(await search('ALICE')).toEqual([orderOf['Alice Anderson']]);
    expect(await search('  bob  ')).toEqual([orderOf['Bob Brown']]); // surrounding spaces are trimmed
    expect(await search('bob@shop')).toEqual([orderOf['Bob Brown']]); // email
    expect(await search(`#${orderOf['Bob Brown']}`)).toEqual([orderOf['Bob Brown']]); // "#12" finds order 12
    expect(await search(String(orderOf['Bob Brown']))).toEqual([orderOf['Bob Brown']]); // "12" finds order 12 too
    // A literal % matches only the name that really contains one; an unescaped % would also match "Wildxxcard".
    expect(await search('d%C')).toEqual([orderOf['Wild%Card']]);
    // A literal _ matches only "A_ice"; an unescaped _ would also match "Alice".
    expect(await search('A_ice')).toEqual([orderOf['A_ice Real']]);

    const none = await ctx.api.get(listUrl({ q: 'zzz-no-such-customer' }));
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ items: [], total: 0, totalPages: 0 });
  });
});

describe('ORD-12: filtering by status', () => {
  test('ORD-12 each status returns exactly its orders, "all" returns everything, an unknown status is 400', async () => {
    const byStatus = {};
    for (const status of ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED']) {
      byStatus[status] = (await f.orderInStatus(ctx.api, status, { customerId: cat.customer.id, items: f.lines([cat.p1, 1]) })).id;
    }

    for (const [status, orderId] of Object.entries(byStatus)) {
      const res = await ctx.api.get(listUrl({ status }));
      expect(res.status).toBe(200);
      expect(ids(res)).toEqual([orderId]);
      expect(res.body.items[0].status).toBe(status);
    }

    const all = await ctx.api.get(listUrl({ status: 'all' }));
    expect(all.body.total).toBe(5);
    expect([...ids(all)].sort((a, b) => a - b)).toEqual(Object.values(byStatus).sort((a, b) => a - b));

    const bad = await ctx.api.get(listUrl({ status: 'BOGUS' }));
    expect(bad.status).toBe(400);
    expect(bad.body.fields).toEqual(['status']);
  });
});

describe('ORD-13: paging', () => {
  test('ORD-13 pages are complete, disjoint and newest first, and the totals add up', async () => {
    const created = [];
    for (let i = 0; i < 30; i += 1) {
      created.push(await f.createOrderSql({ customerId: cat.customer.id, createdAt: minutesAfter(i) }));
    }
    const newestFirst = [...created].reverse();

    const page1 = await ctx.api.get(listUrl({ pageSize: '10', page: '1' }));
    const page2 = await ctx.api.get(listUrl({ pageSize: '10', page: '2' }));
    const page3 = await ctx.api.get(listUrl({ pageSize: '10', page: '3' }));
    const page4 = await ctx.api.get(listUrl({ pageSize: '10', page: '4' }));

    expect(page1.body).toMatchObject({ page: 1, pageSize: 10, total: 30, totalPages: 3 });
    expect(ids(page1)).toEqual(newestFirst.slice(0, 10));
    expect(ids(page2)).toEqual(newestFirst.slice(10, 20));
    expect(ids(page3)).toEqual(newestFirst.slice(20, 30));
    expect(page4.status).toBe(200);
    expect(page4.body).toMatchObject({ items: [], page: 4, total: 30, totalPages: 3 }); // past the end is empty, not an error
  });

  test('ORD-13 the largest page size (100) works and one more is refused', async () => {
    await f.createOrderSql({ customerId: cat.customer.id });

    const ok = await ctx.api.get('/api/orders?pageSize=100');
    expect(ok.status).toBe(200);
    expect(ok.body.pageSize).toBe(100);

    for (const bad of ['pageSize=101', 'pageSize=0', 'page=0', 'page=abc', 'pageSize=1.5']) {
      const res = await ctx.api.get(`/api/orders?${bad}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid request');
    }
  });

  test('ORD-13 orders created in the same second keep a stable order across pages (ties broken by id)', async () => {
    const sameInstant = minutesAfter(0);
    const created = [];
    for (let i = 0; i < 6; i += 1) {
      created.push(await f.createOrderSql({ customerId: cat.customer.id, createdAt: sameInstant }));
    }

    const seen = [];
    for (const page of ['1', '2', '3']) {
      seen.push(...ids(await ctx.api.get(listUrl({ pageSize: '2', page }))));
    }

    expect(seen).toEqual([...created].sort((a, b) => b - a)); // no duplicates, no gaps, descending ids
  });
});

describe('ORD-14: sorting', () => {
  test('ORD-14 sorts by every allowed key in both directions and refuses others', async () => {
    const zed = await f.createCustomer({ name: 'Zed Zimmer', email: 'zed@example.test' });
    const amy = await f.createCustomer({ name: 'Amy Adams', email: 'amy@example.test' });
    const mia = await f.createCustomer({ name: 'Mia Miller', email: 'mia@example.test' });
    const o1 = await f.createOrderSql({ customerId: zed.id, status: 'SHIPPED', totalAmount: '9.00' });
    const o2 = await f.createOrderSql({ customerId: amy.id, status: 'PENDING', totalAmount: '100.00' });
    const o3 = await f.createOrderSql({ customerId: mia.id, status: 'DELIVERED', totalAmount: '25.50' });
    // Oldest to newest: o3, o1, o2 (this sets both created_at and updated_at).
    await backdate('orders', o3, minutesAfter(0));
    await backdate('orders', o1, minutesAfter(1));
    await backdate('orders', o2, minutesAfter(2));

    const order = async (sort, direction) => ids(await ctx.api.get(listUrl({ sort, order: direction })));

    expect(await order('id', 'asc')).toEqual([o1, o2, o3]);
    expect(await order('id', 'desc')).toEqual([o3, o2, o1]);
    expect(await order('totalAmount', 'asc')).toEqual([o1, o3, o2]); // 9.00, 25.50, 100.00: numeric, not alphabetical
    expect(await order('totalAmount', 'desc')).toEqual([o2, o3, o1]);
    expect(await order('customerName', 'asc')).toEqual([o2, o3, o1]); // Amy, Mia, Zed
    expect(await order('customerName', 'desc')).toEqual([o1, o3, o2]);
    expect(await order('createdAt', 'asc')).toEqual([o3, o1, o2]);
    expect(await order('createdAt', 'desc')).toEqual([o2, o1, o3]);
    expect(await order('updatedAt', 'asc')).toEqual([o3, o1, o2]);
    expect(await order('updatedAt', 'desc')).toEqual([o2, o1, o3]);
    // MySQL sorts an ENUM by its position (PENDING, CONFIRMED, SHIPPED, DELIVERED, CANCELLED), not alphabetically.
    expect(await order('status', 'asc')).toEqual([o2, o1, o3]);
    expect(await order('status', 'desc')).toEqual([o3, o1, o2]);

    const badSort = await ctx.api.get(listUrl({ sort: 'password' }));
    expect(badSort.status).toBe(400);
    expect(badSort.body.fields).toEqual(['sort']);
    const badOrder = await ctx.api.get(listUrl({ order: 'sideways' }));
    expect(badOrder.status).toBe(400);
    expect(badOrder.body.fields).toEqual(['order']);
  });
});

describe('ORD-15: the list shape', () => {
  test('ORD-15 shows the item count, the total as text and only the customer fields it should', async () => {
    const p4 = await f.createProduct({ sku: 'P-FOUR', price: '3.00', stock: 10 });
    const one = await f.createOrderViaApi(ctx.api, { customerId: cat.customer.id, items: f.lines([cat.p1, 2]) });
    const three = await f.createOrderViaApi(ctx.api, { customerId: cat.customer.id, items: f.lines([cat.p1, 1], [cat.p2, 1], [p4, 1]) });

    const res = await ctx.api.get(listUrl({ sort: 'id', order: 'asc' }));

    expect(res.status).toBe(200);
    expect(res.body.items.map((o) => [o.id, o.itemCount, o.totalAmount, o.status])).toEqual([
      [one.id, 1, '20.00', 'PENDING'],
      [three.id, 3, '15.50', 'PENDING'], // 10.00 + 2.50 + 3.00
    ]);
    for (const summary of res.body.items) {
      expect(typeof summary.totalAmount).toBe('string');
      expect(Object.keys(summary.customer).sort()).toEqual(['email', 'id', 'name']);
    }
    assertNoSecrets(res.body);
  });
});

// ------------------------------------------------------------------------------------------- status transitions
const ACTION_TARGET = { confirm: 'CONFIRMED', cancel: 'CANCELLED', ship: 'SHIPPED', deliver: 'DELIVERED' };
const ALLOWED = {
  PENDING: ['confirm', 'cancel'],
  CONFIRMED: ['ship', 'cancel'],
  SHIPPED: ['deliver'],
  DELIVERED: [],
  CANCELLED: [],
};

describe('ORD-16: valid status transitions', () => {
  const pairs = (history) => history.map((entry) => [entry.fromStatus, entry.toStatus]);

  test('ORD-16 PENDING -> CONFIRMED -> SHIPPED -> DELIVERED, one history row per step, by the signed-in administrator', async () => {
    const created = await f.createOrderViaApi(ctx.api, { customerId: cat.customer.id, items: f.lines([cat.p1, 2]) });

    for (const [action, status] of [['confirm', 'CONFIRMED'], ['ship', 'SHIPPED'], ['deliver', 'DELIVERED']]) {
      const res = await f.doAction(ctx.api, created.id, action);
      expect(res.status).toBe(200);
      expect(res.body.order.status).toBe(status);
      expect(res.body.order.id).toBe(created.id);
    }

    expect(pairs(await db.orderHistory(created.id))).toEqual([
      [null, 'PENDING'],
      ['PENDING', 'CONFIRMED'],
      ['CONFIRMED', 'SHIPPED'],
      ['SHIPPED', 'DELIVERED'],
    ]);
    expect((await db.orderHistory(created.id)).every((row) => row.changedByAdminId === ctx.admin.id)).toBe(true);
    expect((await db.orderRow(created.id)).status).toBe('DELIVERED');
    const details = await ctx.api.get(`/api/orders/${created.id}`);
    expect(pairs(details.body.order.statusHistory)).toEqual(pairs(await db.orderHistory(created.id)));
  });

  test('ORD-16 a PENDING order can be cancelled', async () => {
    const created = await f.createOrderViaApi(ctx.api, { customerId: cat.customer.id, items: f.lines([cat.p1, 2]) });

    const res = await f.doAction(ctx.api, created.id, 'cancel');

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('CANCELLED');
    expect(pairs(await db.orderHistory(created.id))).toEqual([[null, 'PENDING'], ['PENDING', 'CANCELLED']]);
  });

  test('ORD-16 a CONFIRMED order can be cancelled', async () => {
    const confirmed = await f.orderInStatus(ctx.api, 'CONFIRMED', { customerId: cat.customer.id, items: f.lines([cat.p1, 2]) });

    const res = await f.doAction(ctx.api, confirmed.id, 'cancel');

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('CANCELLED');
    expect(pairs(await db.orderHistory(confirmed.id))).toEqual([
      [null, 'PENDING'],
      ['PENDING', 'CONFIRMED'],
      ['CONFIRMED', 'CANCELLED'],
    ]);
  });
});

describe('ORD-17: invalid status transitions', () => {
  // Every status/action pair that is not in ALLOWED: 15 of the 20 combinations.
  const INVALID_MOVES = [];
  for (const status of Object.keys(ALLOWED)) {
    for (const action of Object.keys(ACTION_TARGET)) {
      if (!ALLOWED[status].includes(action)) INVALID_MOVES.push([status, action]);
    }
  }

  test('ORD-17 the matrix really holds 15 invalid moves', () => {
    expect(INVALID_MOVES).toHaveLength(15);
  });

  test.each(INVALID_MOVES)('ORD-17 a %s order cannot be moved with "%s": 409 and nothing changes', async (status, action) => {
    const order = await f.orderInStatus(ctx.api, status, { customerId: cat.customer.id, items: f.lines([cat.p1, 2]) });
    const before = {
      row: await db.orderRow(order.id),
      history: await db.orderHistory(order.id),
      movements: await db.movementsForOrder(order.id),
      stock: await db.productStock(cat.p1.id),
    };

    const res = await f.doAction(ctx.api, order.id, action);

    const target = ACTION_TARGET[action];
    expect(res.status).toBe(409);
    expect(res.body.currentStatus).toBe(status);
    expect(res.body.error).toBe(
      status === target ? `This order is already ${status}` : `This order is ${status} and cannot be changed to ${target}`
    );
    expect({
      row: await db.orderRow(order.id),
      history: await db.orderHistory(order.id),
      movements: await db.movementsForOrder(order.id),
      stock: await db.productStock(cat.p1.id),
    }).toEqual(before);
  });
});

describe('ORD-18: unknown and invalid order ids on the status routes', () => {
  test.each(Object.keys(ACTION_TARGET))('ORD-18 "%s" on an unknown order is 404 and on an invalid id is 400', async (action) => {
    const missing = await f.doAction(ctx.api, 999999999, action);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Order not found' });

    for (const bad of ['abc', '0', '-5']) {
      const res = await f.doAction(ctx.api, bad, action);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'Invalid request', fields: ['id'] });
    }
    expect(await db.countsOf(WRITE_TABLES)).toEqual(NOTHING_WRITTEN);
  });
});
