// GET /api/activity with the activity repository mocked: no database is touched. These tests prove validation, auth,
// the shape of the response, how the three sources are merged, and that order stock movements are nested inside their
// order events. They do NOT prove the SQL runs on MySQL.
const crypto = require('crypto');

process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.CLIENT_ORIGIN = 'http://localhost:5173';

jest.mock('../../src/repositories/adminRepository', () => ({
  findByEmail: jest.fn(),
  findById: jest.fn(),
  countAll: jest.fn(),
  create: jest.fn(),
}));
jest.mock('../../src/repositories/activityRepository', () => ({
  listKeys: jest.fn(),
  fetchOrderEvents: jest.fn(),
  fetchOrderStockMovements: jest.fn(),
  fetchStockEvents: jest.fn(),
  fetchAuditEvents: jest.fn(),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const adminRepository = require('../../src/repositories/adminRepository');
const activityRepository = require('../../src/repositories/activityRepository');
const { activityQuerySchema } = require('../../src/validation/activitySchemas');
const app = require('../../src/app');

const cookie = () => `admin_token=${jwt.sign({}, process.env.JWT_SECRET, { algorithm: 'HS256', subject: '7', expiresIn: 60 })}`;
const get = (query = '', { withCookie = true } = {}) => {
  const req = request(app).get(`/api/activity${query}`);
  if (withCookie) req.set('Cookie', cookie());
  return req;
};

const ADMIN = { admin_id: 7, admin_email: 'admin@example.com', admin_display_name: null };
const T = (minute) => new Date(`2026-11-01T10:${String(minute).padStart(2, '0')}:00.000Z`);

beforeEach(() => {
  jest.resetAllMocks();
  adminRepository.findById.mockResolvedValue({ id: 7, email: 'admin@example.com', is_active: 1 });
  activityRepository.listKeys.mockResolvedValue({ keys: [], total: 0 });
  activityRepository.fetchOrderEvents.mockResolvedValue([]);
  activityRepository.fetchOrderStockMovements.mockResolvedValue([]);
  activityRepository.fetchStockEvents.mockResolvedValue([]);
  activityRepository.fetchAuditEvents.mockResolvedValue([]);
});

describe('authentication and validation', () => {
  test('401 without a session, and nothing is read', async () => {
    const res = await get('', { withCookie: false });
    expect(res.status).toBe(401);
    expect(activityRepository.listKeys).not.toHaveBeenCalled();
  });

  test('401 for a deactivated administrator', async () => {
    adminRepository.findById.mockResolvedValue({ id: 7, email: 'admin@example.com', is_active: 0 });
    expect((await get()).status).toBe(401);
  });

  test('an empty list: 200 with the documented shape, no-store, and the defaults', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 });
    expect(activityRepository.listKeys).toHaveBeenCalledWith({ q: '', type: 'all', page: 1, pageSize: 25 });
  });

  test('filters are passed through, trimmed and typed', async () => {
    await get('?q=%20ann%20&type=order&from=2026-11-01T00:00:00.000Z&to=2026-11-02T00:00:00.000Z&page=2&pageSize=50');
    expect(activityRepository.listKeys).toHaveBeenCalledWith({
      q: 'ann',
      type: 'order',
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-02T00:00:00.000Z',
      page: 2,
      pageSize: 50,
    });
  });

  test('empty from and to mean "not given"', async () => {
    const res = await get('?from=&to=');
    expect(res.status).toBe(200);
    expect(activityRepository.listKeys.mock.calls[0][0].from).toBeUndefined();
    expect(activityRepository.listKeys.mock.calls[0][0].to).toBeUndefined();
  });

  test.each([
    ['unknown type', '?type=orders', ['type']],
    ['page 0', '?page=0', ['page']],
    ['page size over 100', '?pageSize=101', ['pageSize']],
    ['page size 0', '?pageSize=0', ['pageSize']],
    ['text page', '?page=abc', ['page']],
    ['bad from', '?from=yesterday', ['from']],
    ['date without a time', '?to=2026-11-01', ['to']],
    ['from after to', '?from=2026-11-02T00:00:00.000Z&to=2026-11-01T00:00:00.000Z', ['to']],
    ['from equal to to', '?from=2026-11-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z', ['to']],
    ['search too long', `?q=${'x'.repeat(101)}`, ['q']],
  ])('400 for %s, and nothing is read', async (_label, query, fields) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', fields });
    expect(activityRepository.listKeys).not.toHaveBeenCalled();
  });

  test('every type in the list is accepted', () => {
    for (const type of ['all', 'order', 'stock', 'product', 'customer', 'account', 'settings']) {
      expect(activityQuerySchema.safeParse({ type }).success).toBe(true);
    }
  });
});

describe('merging the sources', () => {
  const orderRow = (id, orderId, from, to, extra = {}) => ({
    id, order_id: orderId, from_status: from, to_status: to, changed_at: T(id), customer_name: 'Ann Lee', total_amount: '31.50', ...ADMIN, ...extra,
  });

  test('keeps the order chosen by the keys query and gives each event its own id, type, actor and entity', async () => {
    activityRepository.listKeys.mockResolvedValue({
      keys: [
        { source: 'audit', id: 3, occurredAt: T(30) },
        { source: 'order', id: 12, occurredAt: T(20) },
        { source: 'stock', id: 8, occurredAt: T(10) },
      ],
      total: 3,
    });
    activityRepository.fetchOrderEvents.mockResolvedValue([orderRow(12, 4, null, 'PENDING')]);
    activityRepository.fetchStockEvents.mockResolvedValue([
      { id: 8, created_at: T(10), product_id: 5, sku: 'SKU-1004', product_name: '27-inch Monitor', quantity_delta: 5, reason: 'Recount', ...ADMIN },
    ]);
    activityRepository.fetchAuditEvents.mockResolvedValue([
      { id: 3, occurred_at: T(30), event_type: 'PRODUCT_DEACTIVATED', entity_type: 'PRODUCT', entity_id: 5, details: null, product_sku: 'SKU-1004', product_name: '27-inch Monitor', customer_name: null, ...ADMIN },
    ]);

    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.items.map((i) => i.id)).toEqual(['audit-3', 'order-12', 'stock-8']);
    expect(res.body.items[0]).toMatchObject({
      type: 'PRODUCT_DEACTIVATED',
      occurredAt: '2026-11-01T10:30:00.000Z',
      actor: { id: 7, email: 'admin@example.com', displayName: null },
      entity: { type: 'product', id: 5, label: 'SKU-1004 — 27-inch Monitor' },
      details: null,
    });
    expect(res.body.items[1]).toMatchObject({
      type: 'ORDER_CREATED',
      entity: { type: 'order', id: 4, label: 'Order #4' },
      details: { fromStatus: null, toStatus: 'PENDING', customerName: 'Ann Lee', totalAmount: '31.50', stockMovements: [] },
    });
    expect(res.body.items[2]).toMatchObject({
      type: 'STOCK_ADJUSTED',
      details: { sku: 'SKU-1004', quantityDelta: 5, reason: 'Recount' },
    });
  });

  test('order stock movements appear INSIDE their order event and never as separate rows', async () => {
    activityRepository.listKeys.mockResolvedValue({
      keys: [
        { source: 'order', id: 24, occurredAt: T(24) }, // cancelled
        { source: 'order', id: 23, occurredAt: T(23) }, // confirmed
        { source: 'order', id: 22, occurredAt: T(22) }, // created
        { source: 'order', id: 21, occurredAt: T(21) }, // another order, confirmed
      ],
      total: 4,
    });
    activityRepository.fetchOrderEvents.mockResolvedValue([
      orderRow(24, 3, 'CONFIRMED', 'CANCELLED'),
      orderRow(23, 3, 'PENDING', 'CONFIRMED'),
      orderRow(22, 3, null, 'PENDING'),
      orderRow(21, 2, 'PENDING', 'CONFIRMED'),
    ]);
    activityRepository.fetchOrderStockMovements.mockResolvedValue([
      { id: 1, order_id: 2, movement_type: 'ORDER_CONFIRMED', product_id: 4, sku: 'SKU-1004', product_name: 'Monitor', quantity_delta: -2 },
      { id: 2, order_id: 3, movement_type: 'ORDER_CONFIRMED', product_id: 4, sku: 'SKU-1004', product_name: 'Monitor', quantity_delta: -3 },
      { id: 3, order_id: 3, movement_type: 'ORDER_CANCELLED', product_id: 4, sku: 'SKU-1004', product_name: 'Monitor', quantity_delta: 3 },
    ]);

    const res = await get();
    const byId = Object.fromEntries(res.body.items.map((i) => [i.id, i]));
    expect(res.body.items).toHaveLength(4); // 3 stock movements, still only 4 order events
    expect(res.body.items.every((i) => i.id.startsWith('order-'))).toBe(true);
    expect(byId['order-23'].details.stockMovements).toEqual([{ productId: 4, sku: 'SKU-1004', productName: 'Monitor', quantityDelta: -3 }]);
    expect(byId['order-24'].details.stockMovements).toEqual([{ productId: 4, sku: 'SKU-1004', productName: 'Monitor', quantityDelta: 3 }]);
    expect(byId['order-22'].details.stockMovements).toEqual([]); // created: no stock effect
    expect(byId['order-21'].details.stockMovements).toEqual([{ productId: 4, sku: 'SKU-1004', productName: 'Monitor', quantityDelta: -2 }]); // not order 3's
    expect(byId['order-23'].type).toBe('ORDER_CONFIRMED');
    expect(byId['order-24'].type).toBe('ORDER_CANCELLED');
    // The movements are looked up once, for the orders on the page only.
    expect(activityRepository.fetchOrderStockMovements).toHaveBeenCalledTimes(1);
    expect(activityRepository.fetchOrderStockMovements.mock.calls[0][0].sort()).toEqual([2, 3]);
  });

  test('a cancelled order that was never confirmed has no stock movements; shipped and delivered never do', async () => {
    activityRepository.listKeys.mockResolvedValue({
      keys: [{ source: 'order', id: 3, occurredAt: T(3) }, { source: 'order', id: 2, occurredAt: T(2) }, { source: 'order', id: 1, occurredAt: T(1) }],
      total: 3,
    });
    activityRepository.fetchOrderEvents.mockResolvedValue([
      orderRow(3, 1, 'PENDING', 'CANCELLED'),
      orderRow(2, 2, 'CONFIRMED', 'SHIPPED'),
      orderRow(1, 2, 'SHIPPED', 'DELIVERED'),
    ]);
    activityRepository.fetchOrderStockMovements.mockResolvedValue([
      { id: 1, order_id: 2, movement_type: 'ORDER_CONFIRMED', product_id: 4, sku: 'S', product_name: 'P', quantity_delta: -2 },
    ]);
    const res = await get();
    expect(res.body.items.map((i) => [i.type, i.details.stockMovements.length])).toEqual([
      ['ORDER_CANCELLED', 0],
      ['ORDER_SHIPPED', 0],
      ['ORDER_DELIVERED', 0],
    ]);
  });

  test('no query is made for a source with nothing on the page', async () => {
    activityRepository.listKeys.mockResolvedValue({ keys: [{ source: 'stock', id: 8, occurredAt: T(1) }], total: 1 });
    activityRepository.fetchStockEvents.mockResolvedValue([{ id: 8, created_at: T(1), product_id: 5, sku: 'S', product_name: 'P', quantity_delta: -1, reason: 'r', ...ADMIN }]);
    await get();
    expect(activityRepository.fetchOrderEvents).toHaveBeenCalledWith([]);
    expect(activityRepository.fetchAuditEvents).toHaveBeenCalledWith([]);
    expect(activityRepository.fetchOrderStockMovements).toHaveBeenCalledWith([]);
    expect(activityRepository.fetchStockEvents).toHaveBeenCalledWith([8]);
  });

  test('a row that vanished between the two queries is skipped, not invented', async () => {
    activityRepository.listKeys.mockResolvedValue({ keys: [{ source: 'order', id: 99, occurredAt: T(1) }, { source: 'stock', id: 8, occurredAt: T(0) }], total: 2 });
    activityRepository.fetchStockEvents.mockResolvedValue([{ id: 8, created_at: T(0), product_id: 5, sku: 'S', product_name: 'P', quantity_delta: -1, reason: 'r', ...ADMIN }]);
    const res = await get();
    expect(res.body.items.map((i) => i.id)).toEqual(['stock-8']);
    expect(res.body.total).toBe(2);
  });

  test('paging numbers are computed from the total', async () => {
    activityRepository.listKeys.mockResolvedValue({ keys: [], total: 51 });
    const res = await get('?pageSize=25&page=3');
    expect(res.body).toMatchObject({ page: 3, pageSize: 25, total: 51, totalPages: 3 });
  });
});

describe('audit events', () => {
  const auditRow = (id, event_type, entity_type, entity_id, details, extra = {}) => ({
    id, occurred_at: T(id), event_type, entity_type, entity_id, details, product_sku: null, product_name: null, customer_name: null, ...ADMIN, ...extra,
  });
  const show = async (rows) => {
    activityRepository.listKeys.mockResolvedValue({ keys: rows.map((r) => ({ source: 'audit', id: r.id, occurredAt: r.occurred_at })), total: rows.length });
    activityRepository.fetchAuditEvents.mockResolvedValue(rows);
    return (await get()).body.items;
  };

  test('product, customer, account and settings events get the right entity and label', async () => {
    const items = await show([
      auditRow(1, 'PRODUCT_UPDATED', 'PRODUCT', 5, { changedFields: ['price'], changes: { price: { from: '1.00', to: '2.00' } } }, { product_sku: 'SKU-1', product_name: 'USB Hub' }),
      auditRow(2, 'CUSTOMER_UPDATED', 'CUSTOMER', 9, { changedFields: ['email'] }, { customer_name: 'Ann Lee' }),
      auditRow(3, 'ACCOUNT_PASSWORD_CHANGED', 'ACCOUNT', 7, null),
      auditRow(4, 'SETTINGS_UPDATED', 'SETTINGS', null, { key: 'low_stock_threshold', from: 5, to: 8 }),
      auditRow(5, 'CUSTOMER_CREATED', 'CUSTOMER', 10, null), // customer no longer joined: falls back to the id
    ]);
    expect(items.map((i) => i.entity)).toEqual([
      { type: 'product', id: 5, label: 'SKU-1 — USB Hub' },
      { type: 'customer', id: 9, label: 'Ann Lee' },
      { type: 'account', id: 7, label: 'Administrator account' },
      { type: 'settings', id: null, label: 'Settings' },
      { type: 'customer', id: 10, label: 'Customer #10' },
    ]);
    expect(items[0].details).toEqual({ changedFields: ['price'], changes: { price: { from: '1.00', to: '2.00' } } });
    expect(items[1].details).toEqual({ changedFields: ['email'] });
    expect(items[3].details).toEqual({ key: 'low_stock_threshold', from: 5, to: 8 });
  });

  test('stored details are checked against the allowlist again: anything outside it is shown as no details', async () => {
    const items = await show([
      auditRow(1, 'CUSTOMER_UPDATED', 'CUSTOMER', 9, { changedFields: ['email'], email: 'ann@example.com', password: 'secret-password-1' }),
      auditRow(2, 'ACCOUNT_PASSWORD_CHANGED', 'ACCOUNT', 7, { passwordHash: '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456' }),
      auditRow(3, 'PRODUCT_UPDATED', 'PRODUCT', 5, { changedFields: ['stock'] }),
      auditRow(4, 'CUSTOMER_UPDATED', 'CUSTOMER', 9, 'not json at all {'),
      auditRow(5, 'SOMETHING_ELSE', 'PRODUCT', 5, { a: 1 }),
    ]);
    expect(items.map((i) => i.details)).toEqual([null, null, null, null, null]);
    expect(JSON.stringify(items)).not.toMatch(/ann@example|secret-password|\$2b\$/);
  });

  test('details stored as a JSON string are parsed and checked', async () => {
    const items = await show([auditRow(1, 'CUSTOMER_UPDATED', 'CUSTOMER', 9, '{"changedFields":["name","phone"]}')]);
    expect(items[0].details).toEqual({ changedFields: ['name', 'phone'] });
  });

  test('the actor shows the display name when there is one', async () => {
    const items = await show([auditRow(1, 'PRODUCT_ACTIVATED', 'PRODUCT', 5, null, { admin_display_name: 'Sam' })]);
    expect(items[0].actor).toEqual({ id: 7, email: 'admin@example.com', displayName: 'Sam' });
  });

  test('no response ever contains a password hash field', async () => {
    const items = await show([auditRow(1, 'PRODUCT_ACTIVATED', 'PRODUCT', 5, null)]);
    expect(JSON.stringify(items)).not.toMatch(/password|hash/i);
  });
});

test('the server answers 500 with a generic message when the history cannot be read', async () => {
  activityRepository.listKeys.mockRejectedValue(Object.assign(new Error("SELECT secret FROM x"), { code: 'ER_X' }));
  const res = await get();
  expect(res.status).toBe(500);
  expect(res.body).toEqual({ error: 'Internal server error' });
});
