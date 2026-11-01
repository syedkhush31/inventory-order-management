// PATCH /api/products/:id and POST /api/products/:id/(de|re)activate with the repositories mocked:
// no database is touched. These tests prove routing, validation, auth and error mapping. They do NOT prove
// that MySQL accepts the UPDATE or reports a duplicate SKU the way the mock does.
const crypto = require('crypto');

process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.CLIENT_ORIGIN = 'http://localhost:5173';

jest.mock('../../src/config/db', () => ({ withTransaction: jest.fn(), getPool: jest.fn() }));
jest.mock('../../src/repositories/auditRepository', () => ({ insert: jest.fn() }));
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
  findByIdForUpdate: jest.fn(),
  update: jest.fn(),
  setActive: jest.fn(),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../../src/config/db');
const auditRepository = require('../../src/repositories/auditRepository');
const adminRepository = require('../../src/repositories/adminRepository');
const productRepository = require('../../src/repositories/productRepository');
const app = require('../../src/app');

const cookie = () =>
  `admin_token=${jwt.sign({}, process.env.JWT_SECRET, { algorithm: 'HS256', subject: '7', expiresIn: 60 })}`;

// The connection of the (fake) transaction: the product write and the audit INSERT must both receive it.
const CONNECTION = { query: jest.fn() };

const ROW = {
  id: 42,
  sku: 'SKU-2001',
  name: 'USB Hub',
  price: '24.50',
  stock_quantity: 15,
  is_active: 1,
  created_at: new Date('2026-10-28T09:00:00Z'),
  updated_at: new Date('2026-10-28T09:00:00Z'),
};

const patch = (id, body, { withCookie = true } = {}) => {
  const req = request(app).patch(`/api/products/${id}`);
  if (withCookie) req.set('Cookie', cookie());
  return req.send(body);
};
const action = (id, name, { withCookie = true } = {}) => {
  const req = request(app).post(`/api/products/${id}/${name}`);
  if (withCookie) req.set('Cookie', cookie());
  return req.send({});
};

const duplicate = (key) =>
  Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY', sqlMessage: `Duplicate entry 'x' for key '${key}'` });

beforeEach(() => {
  jest.resetAllMocks();
  adminRepository.findById.mockResolvedValue({ id: 7, email: 'admin@example.com', is_active: 1 });
  db.withTransaction.mockImplementation(async (fn) => fn(CONNECTION));
  auditRepository.insert.mockResolvedValue(1);
  productRepository.update.mockResolvedValue(undefined);
  productRepository.setActive.mockResolvedValue(undefined);
  productRepository.findById.mockResolvedValue(ROW);
  productRepository.findByIdForUpdate.mockResolvedValue(ROW); // the row as it is before the edit
});

describe('PATCH /api/products/:id', () => {
  test('updates the sent fields and returns the product read back from the database', async () => {
    productRepository.findById.mockResolvedValue({ ...ROW, name: 'USB-C Hub', price: '29.00' });
    const res = await patch(42, { name: ' USB-C Hub ', price: '29.00' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.product).toMatchObject({ id: 42, sku: 'SKU-2001', name: 'USB-C Hub', price: '29.00', isActive: true });
    expect(productRepository.update).toHaveBeenCalledWith(42, { name: 'USB-C Hub', price: '29.00' }, CONNECTION);
    expect(productRepository.findByIdForUpdate).toHaveBeenCalledWith(CONNECTION, 42);
    expect(productRepository.findById).toHaveBeenCalledWith(42);
    // Written on the same connection, by administrator 7, with old and new values for name and price.
    expect(auditRepository.insert).toHaveBeenCalledTimes(1);
    expect(auditRepository.insert).toHaveBeenCalledWith(CONNECTION, {
      adminId: 7,
      eventType: 'PRODUCT_UPDATED',
      entityType: 'PRODUCT',
      entityId: 42,
      // The name changed, so the field is named, but its old and new text is NOT stored. The price carries its values.
      details: { changedFields: ['name', 'price'], changes: { price: { from: '24.50', to: '29.00' } } },
    });
    expect(JSON.stringify(auditRepository.insert.mock.calls[0][1])).not.toMatch(/USB Hub|USB-C Hub/);
  });

  test('works on an inactive product', async () => {
    productRepository.findById.mockResolvedValue({ ...ROW, is_active: 0, name: 'Fixed typo' });
    const res = await patch(42, { name: 'Fixed typo' });
    expect(res.status).toBe(200);
    expect(res.body.product.isActive).toBe(false);
  });

  test.each([
    ['empty body', {}, ['body']],
    ['stock in the body', { stockQuantity: 3 }, ['stockQuantity']],
    ['isActive in the body', { isActive: false }, ['isActive']],
    ['id in the body', { id: 5 }, ['id']],
    ['bad sku', { sku: 'a b' }, ['sku']],
    ['numeric price', { price: 5 }, ['price']],
  ])('400 for %s, and nothing is written', async (_label, body, fields) => {
    const res = await patch(42, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', fields });
    expect(productRepository.update).not.toHaveBeenCalled();
  });

  test.each(['abc', '0', '-3', '1.5', '01'])('400 for the id %p, and nothing is written', async (id) => {
    const res = await patch(id, { name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', fields: ['id'] });
    expect(productRepository.update).not.toHaveBeenCalled();
  });

  test('404 when the product does not exist, and nothing is written or audited', async () => {
    productRepository.findByIdForUpdate.mockResolvedValue(null);
    productRepository.findById.mockResolvedValue(null);
    const res = await patch(999, { name: 'x' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Product not found' });
    expect(productRepository.update).not.toHaveBeenCalled();
    expect(auditRepository.insert).not.toHaveBeenCalled();
  });

  test('an edit that changes nothing (same values, price written differently) is saved but not audited', async () => {
    const res = await patch(42, { name: 'USB Hub', price: '24.5' });
    expect(res.status).toBe(200);
    expect(auditRepository.insert).not.toHaveBeenCalled();
  });

  test('a failed audit write fails the request (the transaction is rolled back by withTransaction)', async () => {
    auditRepository.insert.mockRejectedValue(new Error('audit down'));
    const res = await patch(42, { name: 'Changed' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  test('409 for a duplicate SKU', async () => {
    productRepository.update.mockRejectedValue(duplicate('products.uq_products_sku'));
    const res = await patch(42, { sku: 'TAKEN' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'A product with this SKU already exists', fields: ['sku'] });
    expect(auditRepository.insert).not.toHaveBeenCalled();
  });

  test('a duplicate on some other key is a generic 500', async () => {
    productRepository.update.mockRejectedValue(duplicate('products.PRIMARY'));
    const res = await patch(42, { sku: 'X' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  test('an unexpected database failure is a generic 500 with no details', async () => {
    productRepository.update.mockRejectedValue(
      Object.assign(new Error("UPDATE products SET sku = 'SECRET'"), { code: 'ER_ACCESS_DENIED_ERROR' })
    );
    const res = await patch(42, { sku: 'X' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET|UPDATE/);
  });
});

describe.each([
  ['deactivate', 0],
  ['reactivate', 1],
])('POST /api/products/:id/%s', (name, flag) => {
  // The product as it is before the request: in the opposite state, so the request really changes it.
  const before = { ...ROW, is_active: flag === 1 ? 0 : 1 };

  test('sets the flag, returns the product and audits the change on the same connection', async () => {
    productRepository.findByIdForUpdate.mockResolvedValue(before);
    productRepository.findById.mockResolvedValue({ ...ROW, is_active: flag });
    const res = await action(42, name);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.product.isActive).toBe(flag === 1);
    expect(productRepository.setActive).toHaveBeenCalledWith(42, flag === 1, CONNECTION);
    expect(auditRepository.insert).toHaveBeenCalledTimes(1);
    expect(auditRepository.insert).toHaveBeenCalledWith(CONNECTION, {
      adminId: 7,
      eventType: flag === 1 ? 'PRODUCT_ACTIVATED' : 'PRODUCT_DEACTIVATED',
      entityType: 'PRODUCT',
      entityId: 42,
      details: null,
    });
  });

  test('is idempotent: repeating it succeeds each time, changes nothing and writes no audit record', async () => {
    productRepository.findByIdForUpdate.mockResolvedValue({ ...ROW, is_active: flag }); // already in that state
    productRepository.findById.mockResolvedValue({ ...ROW, is_active: flag });
    expect((await action(42, name)).status).toBe(200);
    expect((await action(42, name)).status).toBe(200);
    expect(productRepository.setActive).not.toHaveBeenCalled();
    expect(auditRepository.insert).not.toHaveBeenCalled();
  });

  test('400 for an invalid id and 404 for an unknown product', async () => {
    const bad = await action('abc', name);
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'Invalid request', fields: ['id'] });
    expect(productRepository.setActive).not.toHaveBeenCalled();

    productRepository.findByIdForUpdate.mockResolvedValue(null);
    productRepository.findById.mockResolvedValue(null);
    const missing = await action(999, name);
    expect(missing.status).toBe(404);
    expect(productRepository.setActive).not.toHaveBeenCalled();
    expect(auditRepository.insert).not.toHaveBeenCalled();
  });

  test('a database failure is a generic 500', async () => {
    productRepository.findByIdForUpdate.mockResolvedValue(before);
    productRepository.setActive.mockRejectedValue(new Error('boom'));
    const res = await action(42, name);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});

describe('authentication and same-origin protection', () => {
  const calls = {
    patch: (opts) => patch(42, { name: 'x' }, opts),
    deactivate: (opts) => action(42, 'deactivate', opts),
    reactivate: (opts) => action(42, 'reactivate', opts),
  };

  test.each(Object.keys(calls))('%s: 401 without a session cookie', async (key) => {
    const res = await calls[key]({ withCookie: false });
    expect(res.status).toBe(401);
    expect(productRepository.update).not.toHaveBeenCalled();
    expect(productRepository.setActive).not.toHaveBeenCalled();
  });

  test('401 for a deactivated administrator', async () => {
    adminRepository.findById.mockResolvedValue({ id: 7, email: 'admin@example.com', is_active: 0 });
    const res = await patch(42, { name: 'x' });
    expect(res.status).toBe(401);
    expect(productRepository.update).not.toHaveBeenCalled();
  });

  test('403 from another origin or a cross-site request', async () => {
    const origin = await request(app)
      .patch('/api/products/42')
      .set('Cookie', cookie())
      .set('Origin', 'http://evil.example')
      .send({ name: 'x' });
    const site = await request(app)
      .post('/api/products/42/deactivate')
      .set('Cookie', cookie())
      .set('Sec-Fetch-Site', 'cross-site')
      .send({});
    expect(origin.status).toBe(403);
    expect(site.status).toBe(403);
    expect(productRepository.update).not.toHaveBeenCalled();
    expect(productRepository.setActive).not.toHaveBeenCalled();
  });

  test('the configured frontend origin is allowed', async () => {
    const res = await request(app)
      .patch('/api/products/42')
      .set('Cookie', cookie())
      .set('Origin', 'http://localhost:5173')
      .send({ name: 'x' });
    expect(res.status).toBe(200);
  });
});
