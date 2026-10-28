// POST /api/products/:id/stock-adjustments with the repositories and the transaction helper mocked: no database
// is touched. The fake transaction records commit/rollback so we can prove the stock change and the history row
// are saved or discarded together. These tests do NOT prove how MySQL locks rows or that the SQL runs; that
// needs the (not yet written) integration tests against inventory_test.
const crypto = require('crypto');

process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.CLIENT_ORIGIN = 'http://localhost:5173';

jest.mock('../../src/config/db', () => ({ withTransaction: jest.fn(), getPool: jest.fn() }));
jest.mock('../../src/repositories/adminRepository', () => ({
  findByEmail: jest.fn(),
  findById: jest.fn(),
  countAll: jest.fn(),
  create: jest.fn(),
}));
jest.mock('../../src/repositories/productRepository', () => ({
  list: jest.fn(),
  create: jest.fn(),
  findById: jest.fn(),
  update: jest.fn(),
  setActive: jest.fn(),
  lockForUpdate: jest.fn(),
  setStockQuantity: jest.fn(),
}));
jest.mock('../../src/repositories/stockAdjustmentRepository', () => ({ insert: jest.fn() }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../../src/config/db');
const adminRepository = require('../../src/repositories/adminRepository');
const productRepository = require('../../src/repositories/productRepository');
const stockAdjustmentRepository = require('../../src/repositories/stockAdjustmentRepository');
const app = require('../../src/app');

const cookie = () =>
  `admin_token=${jwt.sign({}, process.env.JWT_SECRET, { algorithm: 'HS256', subject: '7', expiresIn: 60 })}`;

const CONNECTION = { name: 'transaction-connection' };
const events = []; // 'begin' | 'commit' | 'rollback'

const ROW = {
  id: 42,
  sku: 'SKU-2001',
  name: 'USB Hub',
  price: '24.50',
  stock_quantity: 10,
  is_active: 1,
  created_at: new Date('2026-10-28T09:00:00Z'),
  updated_at: new Date('2026-10-28T09:00:00Z'),
};

const HISTORY_ROW = {
  id: 5,
  product_id: 42,
  quantity_delta: -3,
  reason: 'Damaged in storage',
  admin_id: 7,
  created_at: new Date('2026-10-28T10:00:00Z'),
};

const post = (id, body, { withCookie = true } = {}) => {
  const req = request(app).post(`/api/products/${id}/stock-adjustments`);
  if (withCookie) req.set('Cookie', cookie());
  return req.send(body);
};

const GOOD = { delta: -3, reason: 'Damaged in storage' };

beforeEach(() => {
  jest.resetAllMocks();
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
  productRepository.lockForUpdate.mockResolvedValue({ id: 42, stock_quantity: 10 });
  productRepository.setStockQuantity.mockResolvedValue(undefined);
  productRepository.findById.mockResolvedValue({ ...ROW, stock_quantity: 7 });
  stockAdjustmentRepository.insert.mockResolvedValue(HISTORY_ROW);
});

describe('successful adjustments', () => {
  test('removes stock, records the history row and returns both', async () => {
    const res = await post(42, GOOD);
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.product).toMatchObject({ id: 42, stockQuantity: 7 });
    expect(res.body.adjustment).toEqual({
      id: 5,
      productId: 42,
      quantityDelta: -3,
      reason: 'Damaged in storage',
      adminId: 7,
      createdAt: '2026-10-28T10:00:00.000Z',
    });
  });

  test('everything happens on the transaction connection, in order, then commits once', async () => {
    await post(42, GOOD);
    expect(events).toEqual(['begin', 'commit']);
    expect(productRepository.lockForUpdate).toHaveBeenCalledWith(CONNECTION, 42);
    expect(productRepository.setStockQuantity).toHaveBeenCalledWith(CONNECTION, 42, 7);
    expect(stockAdjustmentRepository.insert).toHaveBeenCalledWith(CONNECTION, {
      productId: 42,
      quantityDelta: -3,
      reason: 'Damaged in storage',
      adminId: 7,
    });
    const order = [
      productRepository.lockForUpdate.mock.invocationCallOrder[0],
      productRepository.setStockQuantity.mock.invocationCallOrder[0],
      stockAdjustmentRepository.insert.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test('adds stock', async () => {
    await post(42, { delta: 25, reason: 'Recount' });
    expect(productRepository.setStockQuantity).toHaveBeenCalledWith(CONNECTION, 42, 35);
  });

  test('removing exactly all the stock is allowed and leaves 0', async () => {
    await post(42, { delta: -10, reason: 'Written off' });
    expect(productRepository.setStockQuantity).toHaveBeenCalledWith(CONNECTION, 42, 0);
    expect(events).toEqual(['begin', 'commit']);
  });

  test('reaching the column maximum exactly is allowed', async () => {
    productRepository.lockForUpdate.mockResolvedValue({ id: 42, stock_quantity: 4294967290 });
    await post(42, { delta: 5, reason: 'Bulk intake' });
    expect(productRepository.setStockQuantity).toHaveBeenCalledWith(CONNECTION, 42, 4294967295);
  });

  test('works on an inactive product', async () => {
    productRepository.findById.mockResolvedValue({ ...ROW, is_active: 0, stock_quantity: 7 });
    const res = await post(42, GOOD);
    expect(res.status).toBe(201);
    expect(res.body.product.isActive).toBe(false);
  });

  test('the administrator id comes from the session, never from the request body', async () => {
    await post(42, GOOD);
    expect(stockAdjustmentRepository.insert.mock.calls[0][1].adminId).toBe(7);
    const spoof = await post(42, { ...GOOD, adminId: 99 });
    expect(spoof.status).toBe(400);
    expect(spoof.body.fields).toEqual(['adminId']);
  });

  test('the reason is trimmed', async () => {
    await post(42, { delta: 1, reason: '  Found on shelf  ' });
    expect(stockAdjustmentRepository.insert.mock.calls[0][1].reason).toBe('Found on shelf');
  });
});

describe('stock rules (409)', () => {
  test('refuses to go below zero, reports the current stock and changes nothing', async () => {
    const res = await post(42, { delta: -11, reason: 'Too many' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Not enough stock for this adjustment', fields: ['delta'], currentStock: 10 });
    expect(productRepository.setStockQuantity).not.toHaveBeenCalled();
    expect(stockAdjustmentRepository.insert).not.toHaveBeenCalled();
    expect(events).toEqual(['begin', 'rollback']);
  });

  test('refuses to exceed the column maximum', async () => {
    productRepository.lockForUpdate.mockResolvedValue({ id: 42, stock_quantity: 4294967290 });
    const res = await post(42, { delta: 6, reason: 'Too many' });
    expect(res.status).toBe(409);
    expect(res.body.fields).toEqual(['delta']);
    expect(res.body.currentStock).toBe(4294967290);
    expect(productRepository.setStockQuantity).not.toHaveBeenCalled();
    expect(events).toEqual(['begin', 'rollback']);
  });
});

describe('atomicity', () => {
  test('if saving the history row fails, the transaction is rolled back and the client gets a generic 500', async () => {
    stockAdjustmentRepository.insert.mockRejectedValue(
      Object.assign(new Error("INSERT INTO stock_adjustments ... 'SECRET'"), { code: 'ER_NO_SUCH_TABLE' })
    );
    const res = await post(42, GOOD);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET|INSERT/);
    expect(events).toEqual(['begin', 'rollback']);
    expect(events).not.toContain('commit');
  });

  test('if updating the stock fails, no history row is written and the transaction is rolled back', async () => {
    productRepository.setStockQuantity.mockRejectedValue(new Error('boom'));
    const res = await post(42, GOOD);
    expect(res.status).toBe(500);
    expect(stockAdjustmentRepository.insert).not.toHaveBeenCalled();
    expect(events).toEqual(['begin', 'rollback']);
  });
});

describe('invalid requests', () => {
  test.each([
    ['missing delta', { reason: 'x' }, ['delta']],
    ['missing reason', { delta: 1 }, ['reason']],
    ['empty body', {}, ['delta', 'reason']],
    ['zero delta', { delta: 0, reason: 'x' }, ['delta']],
    ['decimal delta', { delta: 1.5, reason: 'x' }, ['delta']],
    ['delta as text', { delta: '5', reason: 'x' }, ['delta']],
    ['delta too large', { delta: 2147483648, reason: 'x' }, ['delta']],
    ['delta too small', { delta: -2147483648, reason: 'x' }, ['delta']],
    ['blank reason', { delta: 1, reason: '   ' }, ['reason']],
    ['reason of 256 characters', { delta: 1, reason: 'r'.repeat(256) }, ['reason']],
    ['reason with a control character', { delta: 1, reason: 'a\u0007b' }, ['reason']],
    ['absolute stock instead of a delta', { stockQuantity: 5, delta: 1, reason: 'x' }, ['stockQuantity']],
  ])('400 for %s, and nothing is locked or written', async (_label, body, fields) => {
    const res = await post(42, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', fields });
    expect(db.withTransaction).not.toHaveBeenCalled();
    expect(stockAdjustmentRepository.insert).not.toHaveBeenCalled();
  });

  test.each(['abc', '0', '-1', '1.5'])('400 for the id %p', async (id) => {
    const res = await post(id, GOOD);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', fields: ['id'] });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('404 when the product does not exist, and the transaction is rolled back', async () => {
    productRepository.lockForUpdate.mockResolvedValue(null);
    const res = await post(999, GOOD);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Product not found' });
    expect(events).toEqual(['begin', 'rollback']);
    expect(stockAdjustmentRepository.insert).not.toHaveBeenCalled();
  });
});

describe('authentication and same-origin protection', () => {
  test('401 without a session cookie', async () => {
    const res = await post(42, GOOD, { withCookie: false });
    expect(res.status).toBe(401);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('401 for a deactivated administrator', async () => {
    adminRepository.findById.mockResolvedValue({ id: 7, email: 'admin@example.com', is_active: 0 });
    const res = await post(42, GOOD);
    expect(res.status).toBe(401);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('403 from another origin or a cross-site request', async () => {
    const origin = await request(app)
      .post('/api/products/42/stock-adjustments')
      .set('Cookie', cookie())
      .set('Origin', 'http://evil.example')
      .send(GOOD);
    const site = await request(app)
      .post('/api/products/42/stock-adjustments')
      .set('Cookie', cookie())
      .set('Sec-Fetch-Site', 'cross-site')
      .send(GOOD);
    expect(origin.status).toBe(403);
    expect(site.status).toBe(403);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('the configured frontend origin is allowed', async () => {
    const res = await request(app)
      .post('/api/products/42/stock-adjustments')
      .set('Cookie', cookie())
      .set('Origin', 'http://localhost:5173')
      .send(GOOD);
    expect(res.status).toBe(201);
  });
});
