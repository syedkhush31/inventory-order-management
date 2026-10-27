// POST /api/products with the repositories mocked: no database is touched.
// These tests prove the route, validation, auth and error mapping. They do NOT prove
// that MySQL accepts the INSERT or reports a duplicate SKU the way the mock does.
const crypto = require('crypto');

process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.CLIENT_ORIGIN = 'http://localhost:5173';

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
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const adminRepository = require('../../src/repositories/adminRepository');
const productRepository = require('../../src/repositories/productRepository');
const app = require('../../src/app');

const cookie = () =>
  `admin_token=${jwt.sign({}, process.env.JWT_SECRET, { algorithm: 'HS256', subject: '7', expiresIn: 60 })}`;

const BODY = { sku: 'SKU-2001', name: 'USB Hub', price: '24.50', stockQuantity: 15 };

const DB_ROW = {
  id: 42,
  sku: 'SKU-2001',
  name: 'USB Hub',
  price: '24.50',
  stock_quantity: 15,
  is_active: 1,
  created_at: new Date('2026-10-28T09:00:00Z'),
  updated_at: new Date('2026-10-28T09:00:00Z'),
};

const post = (body, { withCookie = true } = {}) => {
  const req = request(app).post('/api/products');
  if (withCookie) req.set('Cookie', cookie());
  return req.send(body);
};

beforeEach(() => {
  jest.resetAllMocks();
  adminRepository.findById.mockResolvedValue({ id: 7, email: 'admin@example.com', is_active: 1 });
  productRepository.create.mockResolvedValue(42);
  productRepository.findById.mockResolvedValue(DB_ROW);
});

describe('successful creation', () => {
  test('returns 201 with the product read back from the database', async () => {
    const res = await post(BODY);
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      product: {
        id: 42,
        sku: 'SKU-2001',
        name: 'USB Hub',
        price: '24.50',
        stockQuantity: 15,
        isActive: true,
        createdAt: '2026-10-28T09:00:00.000Z',
        updatedAt: '2026-10-28T09:00:00.000Z',
      },
    });
    expect(productRepository.create).toHaveBeenCalledWith(BODY);
    expect(productRepository.findById).toHaveBeenCalledWith(42);
  });

  test('trims the SKU and name, and keeps the price as the exact text', async () => {
    await post({ sku: '  Ab-1.x/Y_2 ', name: '  Spaced Name  ', price: '0.10' });
    expect(productRepository.create).toHaveBeenCalledWith({
      sku: 'Ab-1.x/Y_2',
      name: 'Spaced Name',
      price: '0.10',
      stockQuantity: 0,
    });
  });

  test('omitted and empty-string stock both default to 0', async () => {
    await post({ sku: 'A1', name: 'n', price: '1' });
    await post({ sku: 'A2', name: 'n', price: '1', stockQuantity: '' });
    expect(productRepository.create.mock.calls[0][0].stockQuantity).toBe(0);
    expect(productRepository.create.mock.calls[1][0].stockQuantity).toBe(0);
  });

  test('accepts the boundary values', async () => {
    const res = await post({ sku: 'X'.repeat(64), name: 'n'.repeat(255), price: '99999999.99', stockQuantity: 4294967295 });
    expect(res.status).toBe(201);
  });

  test('the new product is created active because the client cannot set that', async () => {
    const res = await post(BODY);
    expect(res.body.product.isActive).toBe(true);
    expect(productRepository.create.mock.calls[0][0]).not.toHaveProperty('isActive');
  });
});

describe('invalid input (400)', () => {
  test.each([
    ['missing sku', { name: 'n', price: '1' }, ['sku']],
    ['missing name', { sku: 'A', price: '1' }, ['name']],
    ['missing price', { sku: 'A', name: 'n' }, ['price']],
    ['everything missing', {}, ['sku', 'name', 'price']],
    ['sku with a space', { ...BODY, sku: 'AB 12' }, ['sku']],
    ['sku with unsupported characters', { ...BODY, sku: 'AB#12' }, ['sku']],
    ['sku too long', { ...BODY, sku: 'X'.repeat(65) }, ['sku']],
    ['name too long', { ...BODY, name: 'n'.repeat(256) }, ['name']],
    ['name with a control character', { ...BODY, name: 'bad\u0007name' }, ['name']],
    ['price with three decimals', { ...BODY, price: '1.234' }, ['price']],
    ['negative price', { ...BODY, price: '-5.00' }, ['price']],
    ['exponent price', { ...BODY, price: '1e2' }, ['price']],
    ['price over the limit', { ...BODY, price: '100000000.00' }, ['price']],
    ['price sent as a number', { ...BODY, price: 24.5 }, ['price']],
    ['negative stock', { ...BODY, stockQuantity: -1 }, ['stockQuantity']],
    ['decimal stock', { ...BODY, stockQuantity: 1.5 }, ['stockQuantity']],
    ['stock over the limit', { ...BODY, stockQuantity: 4294967296 }, ['stockQuantity']],
    ['several bad fields at once', { sku: '', name: '', price: 'x', stockQuantity: -1 }, ['sku', 'name', 'price', 'stockQuantity']],
  ])('%s', async (_label, body, fields) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
    expect([...res.body.fields].sort()).toEqual([...fields].sort());
    expect(productRepository.create).not.toHaveBeenCalled();
  });

  test.each(['id', 'isActive', 'createdAt', 'updatedAt', 'is_active'])('rejects a supplied "%s" property and names it', async (key) => {
    const res = await post({ ...BODY, [key]: key === 'isActive' ? false : 1 });
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual([key]);
    expect(productRepository.create).not.toHaveBeenCalled();
  });

  test('a request with no JSON body is a 400 with no field names', async () => {
    const res = await request(app).post('/api/products').set('Cookie', cookie()).set('Content-Type', 'text/plain').send('sku=A');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', fields: [] });
    expect(productRepository.create).not.toHaveBeenCalled();
  });

  test('malformed JSON is a generic 400', async () => {
    const res = await request(app).post('/api/products').set('Cookie', cookie()).set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid JSON' });
  });

  test('an oversized body is a 413', async () => {
    const res = await post({ ...BODY, name: 'x'.repeat(20000) });
    expect(res.status).toBe(413);
    expect(productRepository.create).not.toHaveBeenCalled();
  });

  test('SQL text in a field is rejected by validation or kept as plain data, never run', async () => {
    const res = await post({ ...BODY, sku: "A'; DROP TABLE products;--" });
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual(['sku']);

    const named = await post({ ...BODY, name: "Robert'); DROP TABLE products;--" });
    expect(named.status).toBe(201); // allowed text; the repository passes it as a parameter value
    expect(productRepository.create.mock.calls[0][0].name).toBe("Robert'); DROP TABLE products;--");
  });
});

describe('duplicate SKU (409)', () => {
  const duplicate = (key = 'products.uq_products_sku') =>
    Object.assign(new Error('SQL detail that must never reach the client'), {
      code: 'ER_DUP_ENTRY',
      errno: 1062,
      sqlMessage: `Duplicate entry 'SKU-2001' for key '${key}'`,
    });

  test('the unique-key error becomes 409 with the sku field named', async () => {
    productRepository.create.mockRejectedValue(duplicate());
    const res = await post(BODY);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'A product with this SKU already exists', fields: ['sku'] });
    expect(JSON.stringify(res.body)).not.toMatch(/SQL|Duplicate entry|uq_products/);
    expect(productRepository.findById).not.toHaveBeenCalled();
  });

  test('works without any pre-check: two concurrent requests, the database decides', async () => {
    productRepository.create.mockResolvedValueOnce(42).mockRejectedValueOnce(duplicate());
    const [first, second] = await Promise.all([post(BODY), post(BODY)]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(productRepository.create).toHaveBeenCalledTimes(2);
  });

  test('a duplicate on some other key is NOT reported as a SKU conflict', async () => {
    productRepository.create.mockRejectedValue(duplicate('products.PRIMARY'));
    const res = await post(BODY);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});

describe('authentication and same-origin protection', () => {
  test('401 without a session cookie, and nothing is written', async () => {
    const res = await post(BODY, { withCookie: false });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(productRepository.create).not.toHaveBeenCalled();
  });

  test('401 for a tampered cookie', async () => {
    const res = await request(app).post('/api/products').set('Cookie', 'admin_token=not-a-real-token').send(BODY);
    expect(res.status).toBe(401);
    expect(productRepository.create).not.toHaveBeenCalled();
  });

  test('401 for a deactivated administrator', async () => {
    adminRepository.findById.mockResolvedValue({ id: 7, email: 'admin@example.com', is_active: 0 });
    const res = await post(BODY);
    expect(res.status).toBe(401);
    expect(productRepository.create).not.toHaveBeenCalled();
  });

  test('403 when the request comes from another origin', async () => {
    const res = await request(app).post('/api/products').set('Cookie', cookie()).set('Origin', 'http://evil.example').send(BODY);
    expect(res.status).toBe(403);
    expect(productRepository.create).not.toHaveBeenCalled();
  });

  test('403 when the browser marks the request cross-site', async () => {
    const res = await request(app).post('/api/products').set('Cookie', cookie()).set('Sec-Fetch-Site', 'cross-site').send(BODY);
    expect(res.status).toBe(403);
    expect(productRepository.create).not.toHaveBeenCalled();
  });

  test('the configured frontend origin is allowed', async () => {
    const res = await request(app).post('/api/products').set('Cookie', cookie()).set('Origin', 'http://localhost:5173').send(BODY);
    expect(res.status).toBe(201);
  });
});

describe('unexpected failures', () => {
  test('a repository failure returns a generic 500 with no details', async () => {
    productRepository.create.mockRejectedValue(
      Object.assign(new Error("INSERT INTO products ... VALUES ('SKU-2001')"), { code: 'ER_ACCESS_DENIED_ERROR' })
    );
    const res = await post(BODY);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  test('a failure when reading the product back is also a generic 500', async () => {
    productRepository.findById.mockResolvedValue(null);
    const res = await post(BODY);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});

describe('existing list endpoint is unchanged', () => {
  test('GET /api/products still works and validates its query', async () => {
    productRepository.list.mockResolvedValue({ rows: [DB_ROW], total: 1 });
    const ok = await request(app).get('/api/products').set('Cookie', cookie());
    expect(ok.status).toBe(200);
    expect(ok.body.items).toHaveLength(1);

    const bad = await request(app).get('/api/products?page=0').set('Cookie', cookie());
    expect(bad.status).toBe(400);
    expect(bad.body.fields).toEqual(['page']);
  });

  test('other methods are still not routed', async () => {
    const put = await request(app).put('/api/products').set('Cookie', cookie()).send(BODY);
    const del = await request(app).delete('/api/products/1').set('Cookie', cookie());
    expect(put.status).toBe(404);
    expect(del.status).toBe(404);
  });
});
