// SQL text and values built by the stock functions, using a fake transaction connection.
// This proves how the queries are assembled. It does NOT prove they run on a real MySQL server.
const mockPoolQuery = jest.fn();
jest.mock('../../src/config/db', () => ({ getPool: () => ({ query: mockPoolQuery }) }));

const { lockForUpdate, setStockQuantity } = require('../../src/repositories/productRepository');
const { insert } = require('../../src/repositories/stockAdjustmentRepository');
const { stockAdjustmentSchema, MAX_STOCK_DELTA } = require('../../src/validation/productSchemas');

const sqlOf = (connection, call) => connection.query.mock.calls[call][0].replace(/\s+/g, ' ');

describe('productRepository stock functions', () => {
  test('lockForUpdate locks the row with a placeholder id, on the given connection only', async () => {
    const connection = { query: jest.fn().mockResolvedValue([[{ id: 3, stock_quantity: 8 }]]) };
    expect(await lockForUpdate(connection, 3)).toEqual({ id: 3, stock_quantity: 8 });
    expect(sqlOf(connection, 0)).toBe('SELECT id, stock_quantity FROM products WHERE id = ? LIMIT 1 FOR UPDATE');
    expect(connection.query.mock.calls[0][1]).toEqual([3]);
    expect(mockPoolQuery).not.toHaveBeenCalled(); // never the pool: the lock must belong to the transaction
  });

  test('lockForUpdate returns null for a missing product', async () => {
    const connection = { query: jest.fn().mockResolvedValue([[]]) };
    expect(await lockForUpdate(connection, 404)).toBeNull();
  });

  test('setStockQuantity writes an absolute value with placeholders', async () => {
    const connection = { query: jest.fn().mockResolvedValue([{ affectedRows: 1 }]) };
    await setStockQuantity(connection, 3, 12);
    expect(connection.query.mock.calls[0]).toEqual(['UPDATE products SET stock_quantity = ? WHERE id = ?', [12, 3]]);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});

describe('stockAdjustmentRepository.insert', () => {
  test('inserts with placeholders on the given connection and returns the stored row', async () => {
    const stored = { id: 5, product_id: 3, quantity_delta: -2, reason: "It's broken'); --", admin_id: 7 };
    const connection = {
      query: jest.fn().mockResolvedValueOnce([{ insertId: 5 }]).mockResolvedValueOnce([[stored]]),
    };
    const row = await insert(connection, { productId: 3, quantityDelta: -2, reason: "It's broken'); --", adminId: 7 });

    expect(row).toBe(stored);
    expect(sqlOf(connection, 0)).toBe(
      'INSERT INTO stock_adjustments (product_id, quantity_delta, reason, admin_id) VALUES (?, ?, ?, ?)'
    );
    expect(connection.query.mock.calls[0][1]).toEqual([3, -2, "It's broken'); --", 7]);
    expect(connection.query.mock.calls[1][1]).toEqual([5]);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});

describe('stockAdjustmentSchema', () => {
  const ok = { delta: 5, reason: 'Recount' };

  test('accepts the boundary deltas and returns trimmed text', () => {
    expect(stockAdjustmentSchema.safeParse({ delta: MAX_STOCK_DELTA, reason: ' r ' }).data).toEqual({
      delta: MAX_STOCK_DELTA,
      reason: 'r',
    });
    expect(stockAdjustmentSchema.safeParse({ delta: -MAX_STOCK_DELTA, reason: 'r' }).success).toBe(true);
    expect(stockAdjustmentSchema.safeParse({ ...ok, reason: 'r'.repeat(255) }).success).toBe(true);
  });

  test.each([
    ['zero', 0],
    ['negative zero', -0],
    ['decimal', 0.5],
    ['text', '3'],
    ['null', null],
    ['NaN', Number.NaN],
    ['Infinity', Infinity],
    ['unsafe integer', 2 ** 53],
  ])('rejects a delta of %s', (_label, delta) => {
    expect(stockAdjustmentSchema.safeParse({ ...ok, delta }).success).toBe(false);
  });

  test('rejects unknown properties and non-objects', () => {
    expect(stockAdjustmentSchema.safeParse({ ...ok, isActive: true }).success).toBe(false);
    expect(stockAdjustmentSchema.safeParse(null).success).toBe(false);
    expect(stockAdjustmentSchema.safeParse([]).success).toBe(false);
  });
});
