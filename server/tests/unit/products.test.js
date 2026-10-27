// GET /api/products with the repositories mocked: no database is touched.
// These tests check routing, authentication, validation and response shape only.
const crypto = require('crypto');

process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.CLIENT_ORIGIN = 'http://localhost:5173';

jest.mock('../../src/repositories/adminRepository', () => ({
  findByEmail: jest.fn(),
  findById: jest.fn(),
  countAll: jest.fn(),
  create: jest.fn(),
}));
jest.mock('../../src/repositories/productRepository', () => ({ list: jest.fn() }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const adminRepository = require('../../src/repositories/adminRepository');
const productRepository = require('../../src/repositories/productRepository');
const app = require('../../src/app');

const cookie = () =>
  `admin_token=${jwt.sign({}, process.env.JWT_SECRET, { algorithm: 'HS256', subject: '7', expiresIn: 60 })}`;

const DB_ROW = {
  id: 1,
  sku: 'SKU-1001',
  name: 'Wireless Mouse',
  price: '19.99',
  stock_quantity: 120,
  is_active: 1,
  created_at: new Date('2026-10-27T10:00:00Z'),
  updated_at: new Date('2026-10-27T11:00:00Z'),
};

beforeEach(() => {
  productRepository.list.mockReset();
  productRepository.list.mockResolvedValue({ rows: [DB_ROW], total: 1 });
  adminRepository.findById.mockResolvedValue({ id: 7, email: 'admin@example.com', is_active: 1 });
});

describe('authentication', () => {
  test('401 without a session cookie, and the repository is never called', async () => {
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(productRepository.list).not.toHaveBeenCalled();
  });

  test('401 for a deactivated admin', async () => {
    adminRepository.findById.mockResolvedValue({ id: 7, email: 'admin@example.com', is_active: 0 });
    const res = await request(app).get('/api/products').set('Cookie', cookie());
    expect(res.status).toBe(401);
    expect(productRepository.list).not.toHaveBeenCalled();
  });
});

describe('GET /api/products', () => {
  test('returns the paginated shape with defaults and mapped fields', async () => {
    const res = await request(app).get('/api/products').set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      items: [
        {
          id: 1,
          sku: 'SKU-1001',
          name: 'Wireless Mouse',
          price: '19.99',
          stockQuantity: 120,
          isActive: true,
          createdAt: '2026-10-27T10:00:00.000Z',
          updatedAt: '2026-10-27T11:00:00.000Z',
        },
      ],
      page: 1,
      pageSize: 25,
      total: 1,
      totalPages: 1,
    });
    expect(productRepository.list).toHaveBeenCalledWith({
      q: '',
      status: 'active',
      page: 1,
      pageSize: 25,
      sort: 'name',
      order: 'asc',
    });
  });

  test('passes validated, converted query values to the repository', async () => {
    productRepository.list.mockResolvedValue({ rows: [], total: 61 });
    const res = await request(app)
      .get('/api/products')
      .query({ q: '  mouse ', status: 'all', page: '3', pageSize: '20', sort: 'stockQuantity', order: 'desc' })
      .set('Cookie', cookie());
    expect(res.status).toBe(200);
    expect(productRepository.list).toHaveBeenCalledWith({
      q: 'mouse',
      status: 'all',
      page: 3,
      pageSize: 20,
      sort: 'stockQuantity',
      order: 'desc',
    });
    expect(res.body).toMatchObject({ items: [], page: 3, pageSize: 20, total: 61, totalPages: 4 });
  });

  test('inactive products map isActive to false and keep price as a string', async () => {
    productRepository.list.mockResolvedValue({ rows: [{ ...DB_ROW, is_active: 0, price: '189.00', stock_quantity: 0 }], total: 1 });
    const res = await request(app).get('/api/products?status=inactive').set('Cookie', cookie());
    expect(res.body.items[0]).toMatchObject({ isActive: false, price: '189.00', stockQuantity: 0 });
  });

  test.each([
    ['page=0', 'page'],
    ['page=-1', 'page'],
    ['page=1.5', 'page'],
    ['page=abc', 'page'],
    ['page=', 'page'],
    ['pageSize=0', 'pageSize'],
    ['pageSize=101', 'pageSize'],
    ['sort=password_hash', 'sort'],
    ['sort=name;DROP TABLE products', 'sort'],
    ['order=sideways', 'order'],
    ['status=deleted', 'status'],
    [`q=${'a'.repeat(101)}`, 'q'],
    ['q=a&q=b', 'q'],
    ['page=1&page=2', 'page'],
  ])('400 for invalid query "%s"', async (qs, field) => {
    const res = await request(app).get(`/api/products?${qs}`).set('Cookie', cookie());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
    expect(res.body.fields).toContain(field);
    expect(productRepository.list).not.toHaveBeenCalled();
  });

  test('accepts the largest allowed page size', async () => {
    const res = await request(app).get('/api/products?pageSize=100').set('Cookie', cookie());
    expect(res.status).toBe(200);
  });

  test('a database failure returns a generic 500 with no details', async () => {
    productRepository.list.mockRejectedValue(new Error("SELECT * FROM products WHERE name = 'secret'"));
    const res = await request(app).get('/api/products').set('Cookie', cookie());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  test('POST is now routed (full tests in productCreate.test.js); update and delete still are not', async () => {
    const post = await request(app).post('/api/products').set('Cookie', cookie()).send({ sku: 'X' });
    expect(post.status).toBe(400); // reaches validation instead of 404
    expect((await request(app).put('/api/products').set('Cookie', cookie()).send({})).status).toBe(404);
    expect((await request(app).delete('/api/products/1').set('Cookie', cookie())).status).toBe(404);
  });
});
