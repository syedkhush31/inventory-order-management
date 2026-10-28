// GET /api/products/:id/stock-adjustments with the repositories mocked: no database is touched.
// These tests prove routing, validation, auth, paging arithmetic and error mapping. They do NOT prove that
// MySQL accepts the SELECT; the SQL text is only checked against a fake pool further down.
const crypto = require('crypto');

process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.CLIENT_ORIGIN = 'http://localhost:5173';

const mockPoolQuery = jest.fn();
jest.mock('../../src/config/db', () => ({
  withTransaction: jest.fn(),
  getPool: () => ({ query: mockPoolQuery }),
}));
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

const request = require('supertest');
const jwt = require('jsonwebtoken');
const adminRepository = require('../../src/repositories/adminRepository');
const productRepository = require('../../src/repositories/productRepository');
const stockAdjustmentRepository = require('../../src/repositories/stockAdjustmentRepository');
const { stockHistoryQuerySchema } = require('../../src/validation/productSchemas');
const app = require('../../src/app');

const cookie = () =>
  `admin_token=${jwt.sign({}, process.env.JWT_SECRET, { algorithm: 'HS256', subject: '7', expiresIn: 60 })}`;

const PRODUCT_ROW = { id: 42, sku: 'SKU-1004', name: '27-inch Monitor', is_active: 1, stock_quantity: 30 };

const historyRow = (id, overrides = {}) => ({
  id,
  product_id: 42,
  quantity_delta: 5,
  reason: `Reason ${id}`,
  admin_id: 1,
  created_at: new Date('2026-10-28T10:13:44Z'),
  ...overrides,
});

const get = (url, { withCookie = true } = {}) => {
  const req = request(app).get(url);
  if (withCookie) req.set('Cookie', cookie());
  return req;
};

let listSpy;

beforeEach(() => {
  jest.resetAllMocks();
  mockPoolQuery.mockReset();
  adminRepository.findById.mockResolvedValue({ id: 7, email: 'admin@example.com', is_active: 1 });
  productRepository.findById.mockResolvedValue(PRODUCT_ROW);
  listSpy = jest.spyOn(stockAdjustmentRepository, 'listByProduct').mockResolvedValue({ rows: [], total: 0 });
});

afterEach(() => {
  listSpy.mockRestore();
});

describe('successful requests', () => {
  test('returns the page with the fields the history table needs, newest first as the repository gives them', async () => {
    listSpy.mockResolvedValue({
      rows: [
        historyRow(2, { quantity_delta: -3, reason: 'Damaged', admin_id: '4' }),
        historyRow(1, { reason: 'recieved 5 units in warehouse' }),
      ],
      total: 2,
    });
    const res = await get('/api/products/42/stock-adjustments');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      items: [
        { id: 2, productId: 42, quantityDelta: -3, reason: 'Damaged', adminId: 4, createdAt: '2026-10-28T10:13:44.000Z' },
        {
          id: 1,
          productId: 42,
          quantityDelta: 5,
          reason: 'recieved 5 units in warehouse',
          adminId: 1,
          createdAt: '2026-10-28T10:13:44.000Z',
        },
      ],
      page: 1,
      pageSize: 10,
      total: 2,
      totalPages: 1,
    });
    expect(productRepository.findById).toHaveBeenCalledWith(42);
  });

  test('exposes only the administrator ID, never an email or any other personal data', async () => {
    listSpy.mockResolvedValue({ rows: [historyRow(1)], total: 1 });
    const res = await get('/api/products/42/stock-adjustments');
    expect(Object.keys(res.body.items[0]).sort()).toEqual(['adminId', 'createdAt', 'id', 'productId', 'quantityDelta', 'reason']);
    expect(JSON.stringify(res.body)).not.toMatch(/admin@example\.com/);
    expect(adminRepository.findById).toHaveBeenCalledTimes(1); // only the authentication check; no admin lookup per row
  });

  test('an empty history is a normal 200 with no items', async () => {
    const res = await get('/api/products/42/stock-adjustments');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], page: 1, pageSize: 10, total: 0, totalPages: 0 });
  });

  test('works for an inactive product', async () => {
    productRepository.findById.mockResolvedValue({ ...PRODUCT_ROW, is_active: 0 });
    const res = await get('/api/products/42/stock-adjustments');
    expect(res.status).toBe(200);
  });
});

describe('pagination', () => {
  test('passes page and pageSize to the repository and computes totalPages', async () => {
    listSpy.mockResolvedValue({ rows: [historyRow(5)], total: 23 });
    const res = await get('/api/products/42/stock-adjustments?page=3&pageSize=10');
    expect(res.status).toBe(200);
    expect(listSpy).toHaveBeenCalledWith(42, { page: 3, pageSize: 10 });
    expect(res.body).toMatchObject({ page: 3, pageSize: 10, total: 23, totalPages: 3 });
  });

  test('defaults to page 1 with 10 per page', async () => {
    await get('/api/products/42/stock-adjustments');
    expect(listSpy).toHaveBeenCalledWith(42, { page: 1, pageSize: 10 });
  });

  test('a page past the end returns an empty list but keeps the totals', async () => {
    listSpy.mockResolvedValue({ rows: [], total: 4 });
    const res = await get('/api/products/42/stock-adjustments?page=9');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: [], page: 9, total: 4, totalPages: 1 });
  });

  test.each([
    ['page=0', ['page']],
    ['page=-1', ['page']],
    ['page=1.5', ['page']],
    ['page=abc', ['page']],
    ['pageSize=0', ['pageSize']],
    ['pageSize=101', ['pageSize']],
    ['pageSize=x', ['pageSize']],
    ['page=0&pageSize=0', ['page', 'pageSize']],
  ])('400 for %s, and the database is not queried', async (query, fields) => {
    const res = await get(`/api/products/42/stock-adjustments?${query}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', fields });
    expect(productRepository.findById).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
  });

  test('accepts the largest page size', async () => {
    const res = await get('/api/products/42/stock-adjustments?pageSize=100');
    expect(res.status).toBe(200);
    expect(listSpy).toHaveBeenCalledWith(42, { page: 1, pageSize: 100 });
  });
});

describe('invalid and unknown products', () => {
  test.each(['abc', '0', '-3', '1.5', '01', '1e3'])('400 for the id %p', async (id) => {
    const res = await get(`/api/products/${id}/stock-adjustments`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', fields: ['id'] });
    expect(productRepository.findById).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
  });

  test('404 when the product does not exist, so "no such product" differs from "no history yet"', async () => {
    productRepository.findById.mockResolvedValue(null);
    const res = await get('/api/products/999/stock-adjustments');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Product not found' });
    expect(listSpy).not.toHaveBeenCalled();
  });
});

describe('authentication', () => {
  test('401 without a session cookie, and nothing is read', async () => {
    const res = await get('/api/products/42/stock-adjustments', { withCookie: false });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(productRepository.findById).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();
  });

  test('401 for a tampered cookie', async () => {
    const res = await request(app).get('/api/products/42/stock-adjustments').set('Cookie', 'admin_token=nope');
    expect(res.status).toBe(401);
    expect(listSpy).not.toHaveBeenCalled();
  });

  test('401 for a deactivated administrator', async () => {
    adminRepository.findById.mockResolvedValue({ id: 7, email: 'admin@example.com', is_active: 0 });
    const res = await get('/api/products/42/stock-adjustments');
    expect(res.status).toBe(401);
    expect(listSpy).not.toHaveBeenCalled();
  });
});

describe('unexpected failures', () => {
  test('a repository failure is a generic 500 with no details', async () => {
    listSpy.mockRejectedValue(
      Object.assign(new Error("SELECT ... FROM stock_adjustments WHERE product_id = 'SECRET'"), { code: 'ER_NO_SUCH_TABLE' })
    );
    const res = await get('/api/products/42/stock-adjustments');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET|SELECT|stock_adjustments/);
  });

  test('a failure while checking the product is also a generic 500', async () => {
    productRepository.findById.mockRejectedValue(new Error('boom'));
    const res = await get('/api/products/42/stock-adjustments');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});

describe('the read-only endpoint does not change anything', () => {
  test('no write functions are called', async () => {
    listSpy.mockResolvedValue({ rows: [historyRow(1)], total: 1 });
    const insertSpy = jest.spyOn(stockAdjustmentRepository, 'insert');
    await get('/api/products/42/stock-adjustments');
    expect(insertSpy).not.toHaveBeenCalled();
    expect(productRepository.setStockQuantity).not.toHaveBeenCalled();
    expect(productRepository.lockForUpdate).not.toHaveBeenCalled();
    expect(productRepository.update).not.toHaveBeenCalled();
    expect(require('../../src/config/db').withTransaction).not.toHaveBeenCalled();
    insertSpy.mockRestore();
  });

  test('the other methods on this path are still the existing POST only', async () => {
    const put = await request(app).put('/api/products/42/stock-adjustments').set('Cookie', cookie()).send({});
    const del = await request(app).delete('/api/products/42/stock-adjustments').set('Cookie', cookie());
    expect(put.status).toBe(404);
    expect(del.status).toBe(404);
  });
});

describe('stockAdjustmentRepository.listByProduct (SQL text against a fake pool)', () => {
  const sqlOf = (call) => mockPoolQuery.mock.calls[call][0].replace(/\s+/g, ' ');

  beforeEach(() => {
    listSpy.mockRestore(); // use the real repository function here
    mockPoolQuery.mockResolvedValueOnce([[{ total: '23' }]]).mockResolvedValueOnce([[historyRow(1)]]);
  });

  test('counts and selects with placeholders, newest first, with an id tie-breaker', async () => {
    const result = await stockAdjustmentRepository.listByProduct(42, { page: 3, pageSize: 10 });

    expect(result).toEqual({ rows: [historyRow(1)], total: 23 });
    expect(sqlOf(0)).toBe('SELECT COUNT(*) AS total FROM stock_adjustments WHERE product_id = ?');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([42]);
    expect(sqlOf(1)).toBe(
      'SELECT id, product_id, quantity_delta, reason, admin_id, created_at FROM stock_adjustments WHERE product_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
    );
    expect(mockPoolQuery.mock.calls[1][1]).toEqual([42, 10, 20]);
  });

  test('only SELECT statements are issued', async () => {
    await stockAdjustmentRepository.listByProduct(42, { page: 1, pageSize: 5 });
    for (const [sql] of mockPoolQuery.mock.calls) {
      expect(sql.trim()).toMatch(/^SELECT/);
    }
  });

  test.each([
    ['page 0', { page: 0, pageSize: 10 }],
    ['pageSize 0', { page: 1, pageSize: 0 }],
    ['fractional pageSize', { page: 1, pageSize: 2.5 }],
  ])('refuses %s without querying', async (_label, query) => {
    await expect(stockAdjustmentRepository.listByProduct(42, query)).rejects.toThrow();
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});

describe('stockHistoryQuerySchema', () => {
  test('defaults and coercion', () => {
    expect(stockHistoryQuerySchema.parse({})).toEqual({ page: 1, pageSize: 10 });
    expect(stockHistoryQuerySchema.parse({ page: '2', pageSize: '50' })).toEqual({ page: 2, pageSize: 50 });
  });

  test('unknown query parameters are ignored, like the product list', () => {
    expect(stockHistoryQuerySchema.parse({ page: '1', sort: 'x' })).toEqual({ page: 1, pageSize: 10 });
  });
});
