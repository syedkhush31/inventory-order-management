// Checks the SQL text and values the activity repository builds, using a fake pool. This proves how the queries are
// assembled (read-only, placeholders, filters, paging). It does NOT prove they run on a real MySQL server.
const fs = require('fs');
const path = require('path');

const mockQuery = jest.fn();
jest.mock('../../src/config/db', () => ({ getPool: () => ({ query: mockQuery }) }));

const repo = require('../../src/repositories/activityRepository');

const base = { q: '', type: 'all', page: 1, pageSize: 25 };
const squash = (sql) => sql.replace(/\s+/g, ' ').trim();
const placeholders = (sql) => (sql.match(/\?/g) || []).length;

beforeEach(() => {
  mockQuery.mockReset();
});

describe('which sources a type reads', () => {
  test('all reads the three sources; order and stock read one; the rest read the audit log', () => {
    expect(repo.sourcesFor('all')).toEqual(['order', 'stock', 'audit']);
    expect(repo.sourcesFor('order')).toEqual(['order']);
    expect(repo.sourcesFor('stock')).toEqual(['stock']);
    for (const type of ['product', 'customer', 'account', 'settings']) expect(repo.sourcesFor(type)).toEqual(['audit']);
    expect(() => repo.sourcesFor('bogus')).toThrow();
  });
});

describe('buildUnion', () => {
  test('combines the three sources with UNION ALL, each wrapped in parentheses', () => {
    const { sql } = repo.buildUnion(base);
    expect(sql.match(/UNION ALL/g)).toHaveLength(2);
    expect(sql).toContain('FROM order_status_history h');
    expect(sql).toContain('FROM stock_adjustments sa');
    expect(sql).toContain('FROM audit_log al');
  });

  test('manual stock only: order-related stock movements are never their own rows', () => {
    const { sql } = repo.buildUnion({ ...base, type: 'stock' });
    expect(squash(sql)).toContain("WHERE sa.movement_type = 'MANUAL'");
    expect(sql).not.toMatch(/ORDER_CONFIRMED|ORDER_CANCELLED/);
    expect(sql).not.toContain('order_status_history');
    expect(sql).not.toContain('audit_log');
  });

  test('every filter keeps placeholders and values in step', () => {
    const queries = [
      base,
      { ...base, q: 'ann' },
      { ...base, q: '#12' },
      { ...base, q: '12', type: 'order' },
      { ...base, type: 'product', q: 'hub' },
      { ...base, from: '2026-11-01T00:00:00.000Z' },
      { ...base, to: '2026-11-02T00:00:00.000Z' },
      { ...base, q: 'x', from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' },
      { ...base, type: 'settings', q: '5', from: '2026-11-01T00:00:00.000Z' },
    ];
    for (const query of queries) {
      const { sql, values } = repo.buildUnion(query);
      expect(placeholders(sql)).toBe(values.length);
    }
  });

  test('user text is only ever a value, never part of the SQL', () => {
    const evil = "x'; DROP TABLE orders;--";
    const { sql, values } = repo.buildUnion({ ...base, q: evil });
    expect(sql).not.toContain('DROP');
    expect(sql).not.toContain('x\'');
    expect(values.filter((v) => typeof v === 'string' && v.includes('DROP')).length).toBeGreaterThan(0);
  });

  test('LIKE wildcards in the search are escaped', () => {
    const { values } = repo.buildUnion({ ...base, q: '50%_off!', type: 'stock' });
    expect(values[0]).toBe('%50!%!_off!!%');
    expect(repo.escapeLike('a%b_c!d')).toBe('a!%b!_c!!d');
    expect(repo.buildUnion({ ...base, q: 'a', type: 'stock' }).sql).toContain("ESCAPE '!'");
  });

  test('a number or #number also finds that order, other text does not', () => {
    expect(repo.buildUnion({ ...base, q: '#12', type: 'order' }).values).toContain(12);
    expect(repo.buildUnion({ ...base, q: '12', type: 'order' }).values).toContain(12);
    expect(squash(repo.buildUnion({ ...base, q: '12', type: 'order' }).sql)).toContain('h.order_id = ?');
    expect(squash(repo.buildUnion({ ...base, q: 'ann', type: 'order' }).sql)).not.toContain('h.order_id = ?');
    expect(repo.buildUnion({ ...base, q: '12', type: 'stock' }).values).not.toContain(12);
  });

  test('the date range applies to each source\'s own time column; from is inclusive, to is exclusive', () => {
    const { sql, values } = repo.buildUnion({ ...base, from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' });
    expect(sql).toContain('h.changed_at >= ?');
    expect(sql).toContain('h.changed_at < ?');
    expect(sql).toContain('sa.created_at >= ?');
    expect(sql).toContain('al.occurred_at < ?');
    const dates = values.filter((v) => v instanceof Date);
    expect(dates).toHaveLength(6);
    expect(dates[0].toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(dates[1].toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });

  test('a product / customer / account / settings type reads only that entity type of the audit log', () => {
    for (const [type, entity] of [['product', 'PRODUCT'], ['customer', 'CUSTOMER'], ['account', 'ACCOUNT'], ['settings', 'SETTINGS']]) {
      const { sql, values } = repo.buildUnion({ ...base, type });
      expect(sql).toContain('al.entity_type = ?');
      expect(values[0]).toBe(entity);
      expect(sql).not.toContain('order_status_history');
      expect(sql).not.toContain('stock_adjustments');
    }
  });
});

describe('listKeys', () => {
  test('counts first, then reads the page newest first with a fixed tie-break, LIMIT/OFFSET as placeholders', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ total: '42' }]])
      .mockResolvedValueOnce([[{ source: 'order', source_id: '5', occurred_at: new Date('2026-11-01T10:00:00Z') }, { source: 'audit', source_id: 2, occurred_at: new Date('2026-11-01T09:00:00Z') }]]);
    const result = await repo.listKeys({ ...base, page: 3, pageSize: 10 });
    expect(result.total).toBe(42);
    expect(result.keys).toEqual([
      { source: 'order', id: 5, occurredAt: new Date('2026-11-01T10:00:00Z') },
      { source: 'audit', id: 2, occurredAt: new Date('2026-11-01T09:00:00Z') },
    ]);
    const [countSql] = mockQuery.mock.calls[0];
    const [pageSql, pageValues] = mockQuery.mock.calls[1];
    expect(squash(countSql)).toMatch(/^SELECT COUNT\(\*\) AS total FROM \(/);
    expect(squash(pageSql)).toContain('ORDER BY occurred_at DESC, source_rank ASC, source_id DESC LIMIT ? OFFSET ?');
    expect(pageValues.slice(-2)).toEqual([10, 20]);
    expect(placeholders(pageSql)).toBe(pageValues.length);
  });

  test('refuses a page size or offset that is not a safe non-negative integer', async () => {
    await expect(repo.listKeys({ ...base, pageSize: -1 })).rejects.toThrow();
    await expect(repo.listKeys({ ...base, page: 0 })).rejects.toThrow();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('detail lookups', () => {
  test('ask for nothing when there is nothing on the page', async () => {
    expect(await repo.fetchOrderEvents([])).toEqual([]);
    expect(await repo.fetchStockEvents([])).toEqual([]);
    expect(await repo.fetchAuditEvents([])).toEqual([]);
    expect(await repo.fetchOrderStockMovements([])).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('pass the ids as one array value and read only what they need', async () => {
    mockQuery.mockResolvedValue([[{ id: 1 }]]);
    await repo.fetchOrderEvents([1, 2]);
    await repo.fetchStockEvents([3]);
    await repo.fetchAuditEvents([4, 5]);
    await repo.fetchOrderStockMovements([7]);
    expect(mockQuery.mock.calls.map((call) => call[1])).toEqual([[[1, 2]], [[3]], [[4, 5]], [[7]]]);
    for (const [sql] of mockQuery.mock.calls) expect(squash(sql)).toMatch(/^SELECT /);
  });

  test('the stock lookup for the stock source is MANUAL only, and the order movement lookup is ORDER_* only', async () => {
    mockQuery.mockResolvedValue([[]]);
    await repo.fetchStockEvents([1]);
    await repo.fetchOrderStockMovements([1]);
    expect(squash(mockQuery.mock.calls[0][0])).toContain("sa.movement_type = 'MANUAL'");
    expect(squash(mockQuery.mock.calls[1][0])).toContain("sa.movement_type IN ('ORDER_CONFIRMED', 'ORDER_CANCELLED')");
  });

  test('no password hash column is ever selected', async () => {
    mockQuery.mockResolvedValue([[]]);
    await repo.fetchOrderEvents([1]);
    await repo.fetchStockEvents([1]);
    await repo.fetchAuditEvents([1]);
    for (const [sql] of mockQuery.mock.calls) expect(sql).not.toMatch(/password|hash/i);
  });
});

test('the repository is read-only: its source contains no INSERT, UPDATE, DELETE, REPLACE, TRUNCATE, DROP or ALTER', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'repositories', 'activityRepository.js'), 'utf8');
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|TRUNCATE|DROP|ALTER)\b/);
});
