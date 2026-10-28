// /api/customers with the repository mocked: no database is touched. These tests prove routing, validation,
// auth and error mapping. They do NOT prove that MySQL accepts the SQL or reports a duplicate email the way the
// mock does. The SQL text built by the real repository is checked against a fake pool in the last section.
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
jest.mock('../../src/repositories/customerRepository', () => ({
  list: jest.fn(),
  create: jest.fn(),
  findById: jest.fn(),
  update: jest.fn(),
  setActive: jest.fn(),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const adminRepository = require('../../src/repositories/adminRepository');
const customerRepository = require('../../src/repositories/customerRepository');
const app = require('../../src/app');

const cookie = () =>
  `admin_token=${jwt.sign({}, process.env.JWT_SECRET, { algorithm: 'HS256', subject: '7', expiresIn: 60 })}`;

const ROW = {
  id: 42,
  name: 'Ann Lee',
  email: 'ann@example.com',
  phone: '555 0100',
  address: '1 Main St',
  is_active: 1,
  created_at: new Date('2026-10-28T09:00:00Z'),
  updated_at: new Date('2026-10-28T09:00:00Z'),
};

const send = (method, url, body, { withCookie = true } = {}) => {
  const req = request(app)[method](url);
  if (withCookie) req.set('Cookie', cookie());
  return body === undefined ? req : req.send(body);
};

const duplicate = (key) =>
  Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY', sqlMessage: `Duplicate entry 'x' for key '${key}'` });

beforeEach(() => {
  jest.resetAllMocks();
  mockPoolQuery.mockReset();
  adminRepository.findById.mockResolvedValue({ id: 7, email: 'admin@example.com', is_active: 1 });
  customerRepository.list.mockResolvedValue({ rows: [ROW], total: 1 });
  customerRepository.create.mockResolvedValue(42);
  customerRepository.update.mockResolvedValue(undefined);
  customerRepository.setActive.mockResolvedValue(undefined);
  customerRepository.findById.mockResolvedValue(ROW);
});

const WRITE_FUNCTIONS = ['create', 'update', 'setActive'];
const nothingWritten = () => WRITE_FUNCTIONS.forEach((name) => expect(customerRepository[name]).not.toHaveBeenCalled());

describe('GET /api/customers', () => {
  test('returns the page in the documented shape', async () => {
    const res = await send('get', '/api/customers');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      items: [
        {
          id: 42,
          name: 'Ann Lee',
          email: 'ann@example.com',
          phone: '555 0100',
          address: '1 Main St',
          isActive: true,
          createdAt: '2026-10-28T09:00:00.000Z',
          updatedAt: '2026-10-28T09:00:00.000Z',
        },
      ],
      page: 1,
      pageSize: 25,
      total: 1,
      totalPages: 1,
    });
    expect(customerRepository.list).toHaveBeenCalledWith({
      q: '',
      status: 'active',
      sort: 'name',
      order: 'asc',
      page: 1,
      pageSize: 25,
    });
  });

  test('passes search, filter, sort and paging to the repository and computes totalPages', async () => {
    customerRepository.list.mockResolvedValue({ rows: [], total: 51 });
    const res = await send('get', '/api/customers?q=%20ann%20&status=all&page=3&pageSize=20&sort=email&order=desc');
    expect(res.status).toBe(200);
    expect(customerRepository.list).toHaveBeenCalledWith({
      q: 'ann',
      status: 'all',
      sort: 'email',
      order: 'desc',
      page: 3,
      pageSize: 20,
    });
    expect(res.body).toMatchObject({ items: [], page: 3, pageSize: 20, total: 51, totalPages: 3 });
  });

  test('an empty result is a normal 200', async () => {
    customerRepository.list.mockResolvedValue({ rows: [], total: 0 });
    const res = await send('get', '/api/customers?q=nobody');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 });
  });

  test.each([
    ['page=0', ['page']],
    ['pageSize=101', ['pageSize']],
    ['status=deleted', ['status']],
    ['sort=password', ['sort']],
    ['order=up', ['order']],
    [`q=${'x'.repeat(101)}`, ['q']],
  ])('400 for %s, and the database is not queried', async (query, fields) => {
    const res = await send('get', `/api/customers?${query}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', fields });
    expect(customerRepository.list).not.toHaveBeenCalled();
  });

  test('a repository failure is a generic 500 with no details', async () => {
    customerRepository.list.mockRejectedValue(
      Object.assign(new Error("SELECT ... 'SECRET'"), { code: 'ER_ACCESS_DENIED_ERROR' })
    );
    const res = await send('get', '/api/customers');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET|SELECT/);
  });
});

describe('POST /api/customers', () => {
  const BODY = { name: ' Ann Lee ', email: 'ANN@example.com', phone: '555 0100', address: '1 Main St' };

  test('201 with the customer read back from the database; the saved values are the cleaned ones', async () => {
    const res = await send('post', '/api/customers', BODY);
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.customer).toMatchObject({ id: 42, name: 'Ann Lee', email: 'ann@example.com', isActive: true });
    expect(customerRepository.create).toHaveBeenCalledWith({
      name: 'Ann Lee',
      email: 'ann@example.com',
      phone: '555 0100',
      address: '1 Main St',
    });
    expect(customerRepository.findById).toHaveBeenCalledWith(42);
  });

  test('phone and address may be left out', async () => {
    await send('post', '/api/customers', { name: 'Ann', email: 'ann@example.com' });
    expect(customerRepository.create).toHaveBeenCalledWith({ name: 'Ann', email: 'ann@example.com', phone: null, address: null });
  });

  test.each([
    ['missing name', { email: 'a@b.co' }, ['name']],
    ['missing email', { name: 'A' }, ['email']],
    ['bad email', { name: 'A', email: 'nope' }, ['email']],
    ['bad phone', { name: 'A', email: 'a@b.co', phone: 'abc' }, ['phone']],
    ['isActive in the body', { name: 'A', email: 'a@b.co', isActive: false }, ['isActive']],
    ['id in the body', { name: 'A', email: 'a@b.co', id: 5 }, ['id']],
    ['empty body', {}, ['name', 'email']],
  ])('400 for %s, and nothing is written', async (_label, body, fields) => {
    const res = await send('post', '/api/customers', body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', fields });
    nothingWritten();
  });

  test('409 for a duplicate email', async () => {
    customerRepository.create.mockRejectedValue(duplicate('customers.uq_customers_email'));
    const res = await send('post', '/api/customers', BODY);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'A customer with this email already exists', fields: ['email'] });
  });

  test('a duplicate on some other key is a generic 500', async () => {
    customerRepository.create.mockRejectedValue(duplicate('customers.PRIMARY'));
    const res = await send('post', '/api/customers', BODY);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  test('a failure when reading the customer back is a generic 500', async () => {
    customerRepository.findById.mockResolvedValue(null);
    const res = await send('post', '/api/customers', BODY);
    expect(res.status).toBe(500);
  });
});

describe('PATCH /api/customers/:id', () => {
  test('updates the sent fields and returns the customer read back', async () => {
    customerRepository.findById.mockResolvedValue({ ...ROW, name: 'Ann Smith', phone: null });
    const res = await send('patch', '/api/customers/42', { name: ' Ann Smith ', phone: '' });
    expect(res.status).toBe(200);
    expect(res.body.customer).toMatchObject({ id: 42, name: 'Ann Smith', phone: null });
    expect(customerRepository.update).toHaveBeenCalledWith(42, { name: 'Ann Smith', phone: null });
  });

  test('works on an inactive customer', async () => {
    customerRepository.findById.mockResolvedValue({ ...ROW, is_active: 0 });
    const res = await send('patch', '/api/customers/42', { name: 'Fixed typo' });
    expect(res.status).toBe(200);
    expect(res.body.customer.isActive).toBe(false);
  });

  test.each([
    ['empty body', {}, ['body']],
    ['isActive in the body', { isActive: false }, ['isActive']],
    ['id in the body', { id: 5 }, ['id']],
    ['bad email', { email: 'nope' }, ['email']],
    ['blank name', { name: '  ' }, ['name']],
  ])('400 for %s, and nothing is written', async (_label, body, fields) => {
    const res = await send('patch', '/api/customers/42', body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', fields });
    nothingWritten();
  });

  test.each(['abc', '0', '-3', '1.5', '01'])('400 for the id %p, and nothing is written', async (id) => {
    const res = await send('patch', `/api/customers/${id}`, { name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request', fields: ['id'] });
    nothingWritten();
  });

  test('404 when the customer does not exist', async () => {
    customerRepository.findById.mockResolvedValue(null);
    const res = await send('patch', '/api/customers/999', { name: 'x' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Customer not found' });
  });

  test('409 for a duplicate email', async () => {
    customerRepository.update.mockRejectedValue(duplicate('customers.uq_customers_email'));
    const res = await send('patch', '/api/customers/42', { email: 'taken@example.com' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'A customer with this email already exists', fields: ['email'] });
  });

  test('an unexpected database failure is a generic 500', async () => {
    customerRepository.update.mockRejectedValue(Object.assign(new Error("UPDATE 'SECRET'"), { code: 'ER_X' }));
    const res = await send('patch', '/api/customers/42', { name: 'x' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET|UPDATE/);
  });
});

describe.each([
  ['deactivate', 0],
  ['reactivate', 1],
])('POST /api/customers/:id/%s', (name, flag) => {
  test('sets the flag and returns the customer; nothing is deleted', async () => {
    customerRepository.findById.mockResolvedValue({ ...ROW, is_active: flag });
    const res = await send('post', `/api/customers/42/${name}`, {});
    expect(res.status).toBe(200);
    expect(res.body.customer.isActive).toBe(flag === 1);
    expect(customerRepository.setActive).toHaveBeenCalledWith(42, flag === 1);
  });

  test('is idempotent: repeating it succeeds each time', async () => {
    customerRepository.findById.mockResolvedValue({ ...ROW, is_active: flag });
    expect((await send('post', `/api/customers/42/${name}`, {})).status).toBe(200);
    expect((await send('post', `/api/customers/42/${name}`, {})).status).toBe(200);
  });

  test('400 for an invalid id and 404 for an unknown customer', async () => {
    const bad = await send('post', `/api/customers/abc/${name}`, {});
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'Invalid request', fields: ['id'] });
    expect(customerRepository.setActive).not.toHaveBeenCalled();

    customerRepository.findById.mockResolvedValue(null);
    expect((await send('post', `/api/customers/999/${name}`, {})).status).toBe(404);
  });

  test('a database failure is a generic 500', async () => {
    customerRepository.setActive.mockRejectedValue(new Error('boom'));
    const res = await send('post', `/api/customers/42/${name}`, {});
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});

describe('there is no way to delete a customer', () => {
  test('DELETE and PUT are not routed', async () => {
    expect((await send('delete', '/api/customers/42')).status).toBe(404);
    expect((await send('put', '/api/customers/42', { name: 'x' })).status).toBe(404);
    nothingWritten();
  });
});

describe('authentication and same-origin protection (every route)', () => {
  const calls = {
    list: (opts) => send('get', '/api/customers', undefined, opts),
    create: (opts) => send('post', '/api/customers', { name: 'A', email: 'a@b.co' }, opts),
    update: (opts) => send('patch', '/api/customers/42', { name: 'x' }, opts),
    deactivate: (opts) => send('post', '/api/customers/42/deactivate', {}, opts),
    reactivate: (opts) => send('post', '/api/customers/42/reactivate', {}, opts),
  };

  test.each(Object.keys(calls))('%s: 401 without a session cookie, and nothing is read or written', async (key) => {
    const res = await calls[key]({ withCookie: false });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    nothingWritten();
    expect(customerRepository.list).not.toHaveBeenCalled();
  });

  test('401 for a tampered cookie and for a deactivated administrator', async () => {
    const tampered = await request(app).get('/api/customers').set('Cookie', 'admin_token=nope');
    expect(tampered.status).toBe(401);

    adminRepository.findById.mockResolvedValue({ id: 7, email: 'admin@example.com', is_active: 0 });
    const inactive = await send('post', '/api/customers', { name: 'A', email: 'a@b.co' });
    expect(inactive.status).toBe(401);
    nothingWritten();
  });

  test('403 from another origin or a cross-site request, on writes', async () => {
    const origin = await request(app)
      .post('/api/customers')
      .set('Cookie', cookie())
      .set('Origin', 'http://evil.example')
      .send({ name: 'A', email: 'a@b.co' });
    const site = await request(app)
      .post('/api/customers/42/deactivate')
      .set('Cookie', cookie())
      .set('Sec-Fetch-Site', 'cross-site')
      .send({});
    expect(origin.status).toBe(403);
    expect(site.status).toBe(403);
    nothingWritten();
  });

  test('the configured frontend origin is allowed', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set('Cookie', cookie())
      .set('Origin', 'http://localhost:5173')
      .send({ name: 'A', email: 'a@b.co' });
    expect(res.status).toBe(201);
  });
});

describe('customerRepository SQL (real module, fake pool)', () => {
  const real = jest.requireActual('../../src/repositories/customerRepository');
  const sqlOf = (call) => mockPoolQuery.mock.calls[call][0].replace(/\s+/g, ' ');

  beforeEach(() => {
    mockPoolQuery.mockResolvedValue([[{ total: 0 }]]);
  });

  test('list: default query is active only, name ascending, id as tie-breaker, LIMIT/OFFSET as placeholders', async () => {
    await real.list({ q: '', status: 'active', sort: 'name', order: 'asc', page: 3, pageSize: 20 });
    expect(sqlOf(0)).toBe('SELECT COUNT(*) AS total FROM customers WHERE is_active = 1');
    expect(sqlOf(1)).toContain('FROM customers WHERE is_active = 1 ORDER BY name ASC, id ASC LIMIT ? OFFSET ?');
    expect(mockPoolQuery.mock.calls[1][1]).toEqual([20, 40]);
  });

  test('list: search escapes LIKE wildcards and uses placeholders for name, email and phone', async () => {
    await real.list({ q: "50%_off'; DROP TABLE customers", status: 'all', sort: 'email', order: 'desc', page: 1, pageSize: 5 });
    expect(sqlOf(0)).toBe(
      "SELECT COUNT(*) AS total FROM customers WHERE (name LIKE ? ESCAPE '!' OR email LIKE ? ESCAPE '!' OR phone LIKE ? ESCAPE '!')"
    );
    const pattern = "%50!%!_off'; DROP TABLE customers%";
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([pattern, pattern, pattern]);
    expect(sqlOf(1)).toContain('ORDER BY email DESC, id ASC');
    expect(sqlOf(0)).not.toContain('DROP');
  });

  test('list: status filters and the sort whitelist', async () => {
    await real.list({ q: '', status: 'inactive', sort: 'createdAt', order: 'asc', page: 1, pageSize: 5 });
    expect(sqlOf(0)).toContain('WHERE is_active = 0');
    expect(sqlOf(1)).toContain('ORDER BY created_at ASC');
    await expect(
      real.list({ q: '', status: 'all', sort: 'name; DROP TABLE customers', order: 'asc', page: 1, pageSize: 5 })
    ).rejects.toThrow('Unsupported sort key');
    expect(real.SORT_COLUMNS).toEqual({ name: 'name', email: 'email', createdAt: 'created_at', updatedAt: 'updated_at' });
  });

  test('create: inserts with placeholders and returns the new id', async () => {
    mockPoolQuery.mockResolvedValue([{ insertId: 9 }]);
    expect(await real.create({ name: "O'Brien", email: 'o@b.co', phone: null, address: null })).toBe(9);
    expect(mockPoolQuery.mock.calls[0]).toEqual([
      'INSERT INTO customers (name, email, phone, address) VALUES (?, ?, ?, ?)',
      ["O'Brien", 'o@b.co', null, null],
    ]);
  });

  test('update: only the sent fields, null is written as a real value, column names never come from input', async () => {
    mockPoolQuery.mockResolvedValue([{ affectedRows: 1 }]);
    await real.update(9, { name: 'New', phone: null, isActive: false, 'name = 1, is_active': 'x' });
    expect(mockPoolQuery.mock.calls[0]).toEqual(['UPDATE customers SET name = ?, phone = ? WHERE id = ?', ['New', null, 9]]);
  });

  test('update: sends nothing when there is nothing to change', async () => {
    await real.update(9, {});
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  test('setActive writes 1 or 0; there is no DELETE anywhere in the module', async () => {
    mockPoolQuery.mockResolvedValue([{ affectedRows: 1 }]);
    await real.setActive(4, false);
    await real.setActive(4, true);
    expect(mockPoolQuery.mock.calls[0]).toEqual(['UPDATE customers SET is_active = ? WHERE id = ?', [0, 4]]);
    expect(mockPoolQuery.mock.calls[1]).toEqual(['UPDATE customers SET is_active = ? WHERE id = ?', [1, 4]]);
    expect(Object.keys(real)).not.toContain('remove');
    expect(require('fs').readFileSync(require.resolve('../../src/repositories/customerRepository'), 'utf8')).not.toMatch(
      /DELETE\s+FROM/i
    );
  });
});
