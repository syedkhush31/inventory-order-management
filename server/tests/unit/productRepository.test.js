// Checks the SQL text and values the repository builds, using a fake pool.
// This proves how the query is assembled. It does NOT prove it runs on a real MySQL server.
const mysql = require('mysql2');

const mockQuery = jest.fn();
jest.mock('../../src/config/db', () => ({ getPool: () => ({ query: mockQuery }) }));

const { list, escapeLike, SORT_COLUMNS } = require('../../src/repositories/productRepository');

const base = { q: '', status: 'active', sort: 'name', order: 'asc', page: 1, pageSize: 25 };

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValueOnce([[{ total: 7 }]]).mockResolvedValueOnce([[]]);
});

const [countCall, pageCall] = [0, 1];
const sqlOf = (index) => mockQuery.mock.calls[index][0].replace(/\s+/g, ' ');
const valuesOf = (index) => mockQuery.mock.calls[index][1];

describe('list()', () => {
  test('returns rows and the numeric total', async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce([[{ total: '7' }]]).mockResolvedValueOnce([[{ id: 1 }]]);
    expect(await list(base)).toEqual({ rows: [{ id: 1 }], total: 7 });
  });

  test('default query: active only, name ascending, id as tie-breaker, LIMIT/OFFSET as placeholders', async () => {
    await list(base);
    expect(sqlOf(countCall)).toBe('SELECT COUNT(*) AS total FROM products WHERE is_active = 1');
    expect(sqlOf(pageCall)).toContain('FROM products WHERE is_active = 1 ORDER BY name ASC, id ASC LIMIT ? OFFSET ?');
    expect(valuesOf(pageCall)).toEqual([25, 0]);
  });

  test('computes OFFSET from page and pageSize', async () => {
    await list({ ...base, page: 3, pageSize: 20 });
    expect(valuesOf(pageCall)).toEqual([20, 40]);
  });

  test.each([
    ['active', 'WHERE is_active = 1'],
    ['inactive', 'WHERE is_active = 0'],
  ])('status %s adds a fixed condition', async (status, clause) => {
    await list({ ...base, status });
    expect(sqlOf(countCall)).toContain(clause);
  });

  test('status "all" has no WHERE clause', async () => {
    await list({ ...base, status: 'all' });
    expect(sqlOf(countCall)).toBe('SELECT COUNT(*) AS total FROM products ');
  });

  test('search uses placeholders for SKU and name; the text never appears in the SQL', async () => {
    await list({ ...base, q: "mouse'; DROP TABLE products;--" });
    expect(sqlOf(countCall)).toContain("WHERE (sku LIKE ? ESCAPE '!' OR name LIKE ? ESCAPE '!') AND is_active = 1");
    expect(sqlOf(countCall)).not.toContain('DROP');
    expect(sqlOf(pageCall)).not.toContain('DROP');
    const pattern = "%mouse'; DROP TABLE products;--%";
    expect(valuesOf(countCall)).toEqual([pattern, pattern]);
    expect(valuesOf(pageCall)).toEqual([pattern, pattern, 25, 0]);
  });

  test('the final SQL after mysql2 formatting escapes the quote in the search text', async () => {
    await list({ ...base, q: "a'b" });
    const finalSql = mysql.format(mockQuery.mock.calls[countCall][0], valuesOf(countCall));
    expect(finalSql).toContain("LIKE '%a\\'b%' ESCAPE '!'");
  });

  test('LIKE wildcards typed by the user are escaped so they match literally', async () => {
    await list({ ...base, q: '100%_off!' });
    expect(valuesOf(countCall)[0]).toBe('%100!%!_off!!%');
  });

  test.each(Object.entries(SORT_COLUMNS))('sort key %s maps to column %s', async (key, column) => {
    await list({ ...base, sort: key, order: 'desc' });
    expect(sqlOf(pageCall)).toContain(`ORDER BY ${column} DESC, id ASC`);
  });

  test('rejects sort keys outside the whitelist before running any SQL', async () => {
    await expect(list({ ...base, sort: 'password_hash' })).rejects.toThrow('Unsupported sort key');
    await expect(list({ ...base, sort: 'name; DROP TABLE products' })).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('rejects non-integer or negative paging values before running any SQL', async () => {
    await expect(list({ ...base, pageSize: 2.5 })).rejects.toThrow();
    await expect(list({ ...base, pageSize: -1 })).rejects.toThrow();
    await expect(list({ ...base, page: 0 })).rejects.toThrow(); // would give a negative offset
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('escapeLike()', () => {
  test('escapes %, _ and the escape character itself', () => {
    expect(escapeLike('a%b_c!d')).toBe('a!%b!_c!!d');
    expect(escapeLike('plain')).toBe('plain');
  });
});

describe('create()', () => {
  const { create, findById } = require('../../src/repositories/productRepository');

  test('inserts with placeholders in a fixed column order and returns the new id', async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce([{ insertId: 77 }]);

    const id = await create({ sku: "A'B", name: 'Mouse; DROP TABLE products', price: '19.99', stockQuantity: 5 });

    expect(id).toBe(77);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const sql = mockQuery.mock.calls[0][0].replace(/\s+/g, ' ');
    expect(sql).toBe('INSERT INTO products (sku, name, price, stock_quantity) VALUES (?, ?, ?, ?)');
    expect(mockQuery.mock.calls[0][1]).toEqual(["A'B", 'Mouse; DROP TABLE products', '19.99', 5]);
    expect(sql).not.toMatch(/DROP|A'B/);
  });

  test('never sets is_active or the timestamps itself, so the table defaults apply', async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce([{ insertId: 1 }]);
    await create({ sku: 'A', name: 'n', price: '1', stockQuantity: 0 });
    expect(mockQuery.mock.calls[0][0]).not.toMatch(/is_active|created_at|updated_at/);
  });

  test('the price reaches the formatted SQL as an exact quoted string, not a float', async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce([{ insertId: 1 }]);
    await create({ sku: 'A', name: 'n', price: '0.10', stockQuantity: 0 });
    const finalSql = mysql.format(mockQuery.mock.calls[0][0], mockQuery.mock.calls[0][1]);
    expect(finalSql).toContain("VALUES ('A', 'n', '0.10', 0)");
  });

  test('database errors, such as a duplicate key, pass through to the caller unchanged', async () => {
    mockQuery.mockReset();
    const dup = Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
    mockQuery.mockRejectedValueOnce(dup);
    await expect(create({ sku: 'A', name: 'n', price: '1', stockQuantity: 0 })).rejects.toBe(dup);
  });

  test('findById() selects one row by id with a placeholder', async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce([[{ id: 5 }]]);
    expect(await findById(5)).toEqual({ id: 5 });
    expect(mockQuery.mock.calls[0][0].replace(/\s+/g, ' ')).toContain('FROM products WHERE id = ? LIMIT 1');
    expect(mockQuery.mock.calls[0][1]).toEqual([5]);

    mockQuery.mockResolvedValueOnce([[]]);
    expect(await findById(999)).toBeNull();
  });
});
