// POST /api/orders/:id/confirm | cancel | ship | deliver with every repository and the transaction helper mocked:
// no database is touched. The fake transaction records begin / commit / rollback, and a small in-memory "database"
// (order status, product stock, movement rows) is only updated by the mocked write functions, so the tests can show
// that stock, movements and status are saved or discarded together.
//
// These tests do NOT prove how MySQL locks rows (FOR UPDATE ordering, deadlocks, lock waits), that the SQL runs, or
// that the unique key on stock_adjustments exists: the "concurrent" cases below simulate the second request seeing
// the status the first one committed, which is what the order-row lock guarantees on a real server. Real-MySQL
// behaviour is unverified until it is tried manually or with integration tests.
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
jest.mock('../../src/repositories/orderRepository', () => ({
  list: jest.fn(),
  findById: jest.fn(),
  listItems: jest.fn(),
  listStatusHistory: jest.fn(),
  findCustomerForOrder: jest.fn(),
  findProductsForOrder: jest.fn(),
  insertOrder: jest.fn(),
  insertItems: jest.fn(),
  insertStatusHistory: jest.fn(),
  lockOrder: jest.fn(),
  listItemQuantities: jest.fn(),
  updateStatus: jest.fn(),
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
jest.mock('../../src/repositories/stockAdjustmentRepository', () => ({
  insert: jest.fn(),
  insertOrderMovement: jest.fn(),
  listByProduct: jest.fn(),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../../src/config/db');
const adminRepository = require('../../src/repositories/adminRepository');
const orderRepository = require('../../src/repositories/orderRepository');
const productRepository = require('../../src/repositories/productRepository');
const stockAdjustmentRepository = require('../../src/repositories/stockAdjustmentRepository');
const orderService = require('../../src/services/orderService');
const app = require('../../src/app');

const cookie = () =>
  `admin_token=${jwt.sign({}, process.env.JWT_SECRET, { algorithm: 'HS256', subject: '7', expiresIn: 60 })}`;

const CONNECTION = { name: 'transaction-connection' };
const T0 = new Date('2026-10-28T09:00:00Z');

let events; // 'begin' | 'commit' | 'rollback', plus 'lock-order', 'lock-product:<id>' in call order
let committed; // what the fake database holds after the last COMMIT
let working; // the copy the current transaction is changing (thrown away on rollback)

const freshDatabase = (status, stock = { 1: 10, 2: 5 }) => ({
  status,
  stock: { ...stock },
  movements: [],
  history: [],
});
const copyDatabase = (d) => ({
  status: d.status,
  stock: { ...d.stock },
  movements: d.movements.map((m) => ({ ...m })),
  history: d.history.map((h) => ({ ...h })),
});

const LINES = [
  { product_id: 2, quantity: 1 }, // deliberately NOT in id order: the service must still lock 1 before 2
  { product_id: 1, quantity: 3 },
];

const post = (action, id = 12, { withCookie = true } = {}) => {
  const req = request(app).post(`/api/orders/${id}/${action}`);
  if (withCookie) req.set('Cookie', cookie());
  return req.send();
};

const orderRow = () => ({
  id: 12,
  customer_id: 3,
  customer_name: 'Ann Lee',
  customer_email: 'ann@example.com',
  customer_is_active: 1,
  status: committed.status,
  total_amount: '64.97',
  item_count: 2,
  created_at: T0,
  updated_at: T0,
});

beforeEach(() => {
  jest.resetAllMocks();
  mockPoolQuery.mockReset();
  events = [];
  committed = freshDatabase('PENDING');
  working = null;

  adminRepository.findById.mockResolvedValue({ id: 7, email: 'admin@example.com', is_active: 1 });

  // Mimics withTransaction: work on a copy, publish it on commit, drop it on rollback. Transactions run one at a
  // time, in the order they start: this stands in for the order-row lock (SELECT ... FOR UPDATE), which on a real
  // server makes a second transaction on the same order wait until the first has committed.
  let queue = Promise.resolve();
  db.withTransaction.mockImplementation((fn) => {
    const run = async () => {
      events.push('begin');
      working = copyDatabase(committed);
      try {
        const result = await fn(CONNECTION);
        committed = working;
        events.push('commit');
        return result;
      } catch (err) {
        events.push('rollback');
        throw err;
      } finally {
        working = null;
      }
    };
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  });

  orderRepository.lockOrder.mockImplementation(async (connection, id) => {
    expect(connection).toBe(CONNECTION);
    events.push('lock-order');
    return { id, status: working.status };
  });
  orderRepository.listItemQuantities.mockResolvedValue(LINES);
  orderRepository.updateStatus.mockImplementation(async (connection, id, status) => {
    expect(connection).toBe(CONNECTION);
    working.status = status;
  });
  orderRepository.insertStatusHistory.mockImplementation(async (connection, entry) => {
    expect(connection).toBe(CONNECTION);
    working.history.push(entry);
  });
  productRepository.lockForUpdate.mockImplementation(async (connection, id) => {
    expect(connection).toBe(CONNECTION);
    events.push(`lock-product:${id}`);
    return { id, stock_quantity: working.stock[id] };
  });
  productRepository.setStockQuantity.mockImplementation(async (connection, id, quantity) => {
    expect(connection).toBe(CONNECTION);
    working.stock[id] = quantity;
  });
  stockAdjustmentRepository.insertOrderMovement.mockImplementation(async (connection, movement) => {
    expect(connection).toBe(CONNECTION);
    working.movements.push(movement);
  });

  // The read-back after the commit.
  orderRepository.findById.mockImplementation(async () => orderRow());
  orderRepository.listItems.mockResolvedValue([
    { id: 1, product_id: 1, sku: 'SKU-1', product_name: 'Widget', quantity: 3, unit_price: '19.99' },
    { id: 2, product_id: 2, sku: 'SKU-2', product_name: 'Gadget', quantity: 1, unit_price: '5.00' },
  ]);
  orderRepository.listStatusHistory.mockResolvedValue([
    { id: 1, order_id: 12, from_status: null, to_status: 'PENDING', changed_by_admin_id: 7, changed_at: T0 },
  ]);
});

// Polls until the condition holds (the fake database is in-memory, so this takes a few event-loop turns).
async function until(condition) {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!condition()) throw new Error('Timed out waiting for the test condition');
}

// Sends two requests for the same order with a KNOWN arrival order, instead of hoping Promise.all delivers them in
// the order written. The first request is held inside its transaction (right after it locks the order) until the
// second request has arrived and is waiting for its own transaction, which is what two real simultaneous requests
// look like. Then the first one is released. Returns [firstResponse, secondResponse].
async function sendInOrder(firstAction, secondAction) {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const lockOrder = orderRepository.lockOrder.getMockImplementation();
  let held = false;
  orderRepository.lockOrder.mockImplementation(async (connection, id) => {
    const row = await lockOrder(connection, id);
    if (!held) {
      held = true;
      await gate;
    }
    return row;
  });

  // Counted from here, so requests the test already made before calling this helper do not confuse the waiting.
  const eventsBefore = events.length;
  const transactionsBefore = db.withTransaction.mock.calls.length;
  try {
    const first = post(firstAction).then((res) => res); // .then() is what actually sends a supertest request
    await until(() => events.slice(eventsBefore).includes('lock-order')); // the first transaction holds the order
    const second = post(secondAction).then((res) => res);
    await until(() => db.withTransaction.mock.calls.length === transactionsBefore + 2); // the second is queued behind it
    release();
    return await Promise.all([first, second]);
  } finally {
    release(); // never leave the first request waiting if something above failed
  }
}

const lockedProducts = () => events.filter((e) => e.startsWith('lock-product:')).map((e) => Number(e.split(':')[1]));

describe('authentication, same-origin protection and ids', () => {
  const actions = ['confirm', 'cancel', 'ship', 'deliver'];

  test.each(actions)('POST /:id/%s without a session is 401 and touches nothing', async (action) => {
    const res = await post(action, 12, { withCookie: false });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test.each(actions)('a cross-site POST /:id/%s is 403 and touches nothing', async (action) => {
    const res = await request(app)
      .post(`/api/orders/12/${action}`)
      .set('Cookie', cookie())
      .set('Origin', 'http://evil.example')
      .send();
    expect(res.status).toBe(403);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test.each(actions)('an invalid id on /%s is 400', async (action) => {
    for (const id of ['0', 'abc', '-1', '1.5', '1234567890123456']) {
      const res = await post(action, id);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request', fields: ['id'] });
    }
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test.each(actions)('GET on /:id/%s does not exist', async (action) => {
    const res = await request(app).get(`/api/orders/12/${action}`).set('Cookie', cookie());
    expect(res.status).toBe(404);
  });

  test.each(actions)('an unknown order on /%s is 404 and nothing is written', async (action) => {
    orderRepository.lockOrder.mockResolvedValue(null);
    const res = await post(action, 999);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Order not found' });
    expect(events).toEqual(['begin', 'rollback']);
    expect(orderRepository.updateStatus).not.toHaveBeenCalled();
    expect(orderRepository.insertStatusHistory).not.toHaveBeenCalled();
    expect(productRepository.setStockQuantity).not.toHaveBeenCalled();
  });
});

describe('confirm: PENDING -> CONFIRMED', () => {
  test('deducts the stock, records one movement per product, the new status and the history, then commits once', async () => {
    const res = await post('confirm');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.order).toMatchObject({ id: 12, status: 'CONFIRMED' });

    expect(events.filter((e) => e === 'begin' || e === 'commit' || e === 'rollback')).toEqual(['begin', 'commit']);
    expect(committed.stock).toEqual({ 1: 7, 2: 4 }); // 10 - 3, 5 - 1
    expect(committed.status).toBe('CONFIRMED');
    expect(committed.movements).toEqual([
      { productId: 1, quantityDelta: -3, reason: 'Order #12 confirmed', adminId: 7, orderId: 12, movementType: 'ORDER_CONFIRMED' },
      { productId: 2, quantityDelta: -1, reason: 'Order #12 confirmed', adminId: 7, orderId: 12, movementType: 'ORDER_CONFIRMED' },
    ]);
    expect(committed.history).toEqual([{ orderId: 12, fromStatus: 'PENDING', toStatus: 'CONFIRMED', adminId: 7 }]);
  });

  test('locks the order first, then the products in ascending id order whatever order the lines come in', async () => {
    await post('confirm');
    expect(events.slice(0, 4)).toEqual(['begin', 'lock-order', 'lock-product:1', 'lock-product:2']);
    expect(lockedProducts()).toEqual([1, 2]);
  });

  test('every product is locked before any stock is written', async () => {
    const calls = [];
    productRepository.lockForUpdate.mockImplementation(async (c, id) => (calls.push(`lock:${id}`), { id, stock_quantity: 10 }));
    productRepository.setStockQuantity.mockImplementation(async (c, id) => calls.push(`set:${id}`));
    await post('confirm');
    expect(calls).toEqual(['lock:1', 'lock:2', 'set:1', 'set:2']);
  });

  test('exactly enough stock is allowed and leaves zero (never negative)', async () => {
    committed = freshDatabase('PENDING', { 1: 3, 2: 1 });
    const res = await post('confirm');
    expect(res.status).toBe(200);
    expect(committed.stock).toEqual({ 1: 0, 2: 0 });
  });

  test('products deactivated after the order was placed can still be confirmed (approved rule)', async () => {
    // Every way confirmation could look at a product's active flag reports the product as INACTIVE here: the row
    // returned by the lock, and a plain product lookup. If confirmation rejected inactive products through either, this
    // test would get a non-200 answer and fail. (The real lock query selects only id and stock_quantity; that exact
    // SQL is asserted in stockAdjustmentRepositories.test.js, so it cannot start filtering on is_active unnoticed.)
    productRepository.lockForUpdate.mockImplementation(async (connection, id) => {
      events.push(`lock-product:${id}`);
      return { id, stock_quantity: working.stock[id], is_active: 0 };
    });
    productRepository.findById.mockResolvedValue({ id: 1, is_active: 0 });

    const res = await post('confirm');
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('CONFIRMED');
    expect(committed.stock).toEqual({ 1: 7, 2: 4 }); // the stock of the inactive products WAS deducted
    expect(committed.movements).toHaveLength(2);
  });

  test('the order row is locked before any product row is locked', async () => {
    await post('confirm');
    expect(events.indexOf('lock-order')).toBeLessThan(events.indexOf('lock-product:1'));
  });

  test('the decision to allow the move uses the status read under the lock, not an earlier read', async () => {
    // The unlocked read (used for the response) says PENDING, but the locked row says CONFIRMED: the move is refused.
    orderRepository.lockOrder.mockResolvedValue({ id: 12, status: 'CONFIRMED' });
    committed = freshDatabase('PENDING');
    const res = await post('confirm');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'This order is already CONFIRMED', currentStatus: 'CONFIRMED' });
    expect(productRepository.setStockQuantity).not.toHaveBeenCalled();
    expect(orderRepository.updateStatus).not.toHaveBeenCalled();
  });
});

describe('confirm: insufficient stock', () => {
  test('one short product refuses the whole confirmation: 409, rollback, nothing changed', async () => {
    committed = freshDatabase('PENDING', { 1: 2, 2: 5 }); // product 1 needs 3
    const res = await post('confirm');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'Not enough stock to confirm this order',
      shortages: [{ productId: 1, requested: 3, available: 2 }],
    });
    expect(events.filter((e) => e === 'commit' || e === 'rollback')).toEqual(['rollback']);
    expect(committed).toEqual(freshDatabase('PENDING', { 1: 2, 2: 5 }));
    expect(productRepository.setStockQuantity).not.toHaveBeenCalled();
    expect(stockAdjustmentRepository.insertOrderMovement).not.toHaveBeenCalled();
    expect(orderRepository.updateStatus).not.toHaveBeenCalled();
    expect(orderRepository.insertStatusHistory).not.toHaveBeenCalled();
  });

  test('the shortage is found even in the LAST product, and the first (sufficient) one is not deducted either', async () => {
    committed = freshDatabase('PENDING', { 1: 10, 2: 0 }); // product 2 needs 1
    const res = await post('confirm');
    expect(res.status).toBe(409);
    expect(res.body.shortages).toEqual([{ productId: 2, requested: 1, available: 0 }]);
    expect(committed.stock).toEqual({ 1: 10, 2: 0 });
    expect(productRepository.setStockQuantity).not.toHaveBeenCalled();
  });

  test('every short product is reported, not only the first', async () => {
    committed = freshDatabase('PENDING', { 1: 0, 2: 0 });
    const res = await post('confirm');
    expect(res.body.shortages).toEqual([
      { productId: 1, requested: 3, available: 0 },
      { productId: 2, requested: 1, available: 0 },
    ]);
  });

  test('the order stays PENDING and can be confirmed once stock arrives', async () => {
    committed = freshDatabase('PENDING', { 1: 0, 2: 0 });
    expect((await post('confirm')).status).toBe(409);
    expect(committed.status).toBe('PENDING');

    committed.stock = { 1: 3, 2: 1 }; // a manual stock correction happened in between
    expect((await post('confirm')).status).toBe(200);
    expect(committed.status).toBe('CONFIRMED');
    expect(committed.stock).toEqual({ 1: 0, 2: 0 });
  });
});

describe('confirm: rollback after a failure part-way through', () => {
  const boom = () => Object.assign(new Error('INSERT secret customer data'), { code: 'ER_BOOM' });

  test('a failure while writing the SECOND product leaves stock, movements, status and history untouched', async () => {
    let writes = 0;
    productRepository.setStockQuantity.mockImplementation(async (c, id, quantity) => {
      writes += 1;
      if (writes === 2) throw boom();
      working.stock[id] = quantity;
    });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post('confirm');
    spy.mockRestore();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toMatch(/INSERT|secret|ER_BOOM/);
    expect(writes).toBe(2); // the first product WAS written inside the transaction, then discarded
    expect(events.filter((e) => e === 'commit' || e === 'rollback')).toEqual(['rollback']);
    expect(committed).toEqual(freshDatabase('PENDING'));
  });

  test('a failure recording a movement (for example the unique key) rolls everything back', async () => {
    let inserts = 0;
    stockAdjustmentRepository.insertOrderMovement.mockImplementation(async (c, movement) => {
      inserts += 1;
      if (inserts === 2) throw Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
      working.movements.push(movement);
    });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post('confirm');
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(committed).toEqual(freshDatabase('PENDING'));
  });

  test.each([
    ['updating the status', () => orderRepository.updateStatus],
    ['writing the history record', () => orderRepository.insertStatusHistory],
  ])('a failure %s rolls the stock deduction back too', async (_label, pick) => {
    pick().mockRejectedValue(boom());
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post('confirm');
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(events.filter((e) => e === 'commit' || e === 'rollback')).toEqual(['rollback']);
    expect(committed).toEqual(freshDatabase('PENDING'));
  });

  test('a failure locking a product rolls back with nothing written', async () => {
    productRepository.lockForUpdate.mockRejectedValue(boom());
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post('confirm');
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(committed).toEqual(freshDatabase('PENDING'));
    expect(productRepository.setStockQuantity).not.toHaveBeenCalled();
  });

  test('an order with no lines (cannot exist in practice) confirms with no stock change', async () => {
    // Orders always have 1-50 lines (enforced when created); this only documents what the code would do.
    orderRepository.listItemQuantities.mockResolvedValue([]);
    const res = await post('confirm');
    expect(res.status).toBe(200);
    expect(committed.stock).toEqual({ 1: 10, 2: 5 });
    expect(committed.movements).toEqual([]);
  });
});

describe('duplicate and concurrent-style requests', () => {
  test('confirming twice in a row deducts once: the second request is 409 and changes nothing', async () => {
    expect((await post('confirm')).status).toBe(200);
    const stockAfterFirst = { ...committed.stock };
    const movementsAfterFirst = committed.movements.length;

    const second = await post('confirm');
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'This order is already CONFIRMED', currentStatus: 'CONFIRMED' });
    expect(committed.stock).toEqual(stockAfterFirst);
    expect(committed.movements).toHaveLength(movementsAfterFirst);
    expect(committed.history).toHaveLength(1);
  });

  // The next tests use sendInOrder: the second request really arrives while the first is still inside its transaction,
  // and the fake transaction runs them one after the other (standing in for the order-row lock; see the note at the top).
  test('two confirms at the same moment: the first deducts, the second sees CONFIRMED and deducts nothing', async () => {
    const [first, second] = await sendInOrder('confirm', 'confirm');
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'This order is already CONFIRMED', currentStatus: 'CONFIRMED' });
    expect(committed.stock).toEqual({ 1: 7, 2: 4 }); // deducted once, not twice
    expect(committed.movements).toHaveLength(2);
    expect(committed.history).toHaveLength(1);
  });

  test('confirm arrives first, cancel second: both succeed, one after the other, and stock ends where it started', async () => {
    const [confirm, cancel] = await sendInOrder('confirm', 'cancel');
    expect(confirm.status).toBe(200);
    expect(cancel.status).toBe(200); // PENDING -> CONFIRMED, then CONFIRMED -> CANCELLED
    expect(committed.status).toBe('CANCELLED');
    expect(committed.stock).toEqual({ 1: 10, 2: 5 }); // deducted once, restored once
    expect(committed.movements.map((m) => `${m.movementType}:${m.productId}:${m.quantityDelta}`)).toEqual([
      'ORDER_CONFIRMED:1:-3',
      'ORDER_CONFIRMED:2:-1',
      'ORDER_CANCELLED:1:3',
      'ORDER_CANCELLED:2:1',
    ]);
    expect(committed.history.map((h) => `${h.fromStatus}>${h.toStatus}`)).toEqual(['PENDING>CONFIRMED', 'CONFIRMED>CANCELLED']);
  });

  test('cancel arrives first, confirm second: the confirm is refused and no stock is ever deducted', async () => {
    const [cancel, confirm] = await sendInOrder('cancel', 'confirm');
    expect(cancel.status).toBe(200); // PENDING -> CANCELLED, no stock change
    expect(confirm.status).toBe(409);
    expect(confirm.body).toEqual({ error: 'This order is CANCELLED and cannot be changed to CONFIRMED', currentStatus: 'CANCELLED' });
    expect(committed.status).toBe('CANCELLED');
    expect(committed.stock).toEqual({ 1: 10, 2: 5 });
    expect(committed.movements).toEqual([]);
    expect(committed.history.map((h) => `${h.fromStatus}>${h.toStatus}`)).toEqual(['PENDING>CANCELLED']);
  });

  test('a stale client that still thinks the order is PENDING cannot re-confirm a SHIPPED order', async () => {
    committed = freshDatabase('SHIPPED', { 1: 7, 2: 4 });
    const res = await post('confirm');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'This order is SHIPPED and cannot be changed to CONFIRMED', currentStatus: 'SHIPPED' });
    expect(committed.stock).toEqual({ 1: 7, 2: 4 });
  });
});

describe('cancel', () => {
  test('cancelling a PENDING order changes no stock and records no movement', async () => {
    const res = await post('cancel');
    expect(res.status).toBe(200);
    expect(committed.status).toBe('CANCELLED');
    expect(committed.stock).toEqual({ 1: 10, 2: 5 });
    expect(committed.movements).toEqual([]);
    expect(committed.history).toEqual([{ orderId: 12, fromStatus: 'PENDING', toStatus: 'CANCELLED', adminId: 7 }]);
    expect(productRepository.lockForUpdate).not.toHaveBeenCalled();
    expect(productRepository.setStockQuantity).not.toHaveBeenCalled();
    expect(stockAdjustmentRepository.insertOrderMovement).not.toHaveBeenCalled();
  });

  test('cancelling a CONFIRMED order puts exactly the deducted quantities back, with movements and history', async () => {
    await post('confirm');
    expect(committed.stock).toEqual({ 1: 7, 2: 4 });
    committed.movements = []; // look only at what the cancellation writes
    committed.history = [];
    events.length = 0;

    const res = await post('cancel');
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('CANCELLED');
    expect(committed.stock).toEqual({ 1: 10, 2: 5 });
    expect(committed.movements).toEqual([
      { productId: 1, quantityDelta: 3, reason: 'Order #12 cancelled', adminId: 7, orderId: 12, movementType: 'ORDER_CANCELLED' },
      { productId: 2, quantityDelta: 1, reason: 'Order #12 cancelled', adminId: 7, orderId: 12, movementType: 'ORDER_CANCELLED' },
    ]);
    expect(committed.history).toEqual([{ orderId: 12, fromStatus: 'CONFIRMED', toStatus: 'CANCELLED', adminId: 7 }]);
    expect(events.filter((e) => e === 'begin' || e === 'commit' || e === 'rollback')).toEqual(['begin', 'commit']);
  });

  test('restore locks the products in ascending id order too', async () => {
    committed = freshDatabase('CONFIRMED', { 1: 7, 2: 4 });
    await post('cancel');
    expect(events.slice(0, 4)).toEqual(['begin', 'lock-order', 'lock-product:1', 'lock-product:2']);
  });

  test('stock is restored exactly once: a second cancel is 409 and adds nothing', async () => {
    await post('confirm');
    expect((await post('cancel')).status).toBe(200);
    expect(committed.stock).toEqual({ 1: 10, 2: 5 });
    const movements = committed.movements.length;

    const again = await post('cancel');
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'This order is already CANCELLED', currentStatus: 'CANCELLED' });
    expect(committed.stock).toEqual({ 1: 10, 2: 5 }); // not 13 / 6
    expect(committed.movements).toHaveLength(movements);
  });

  test('two cancel requests at the same moment restore once', async () => {
    await post('confirm');
    const [first, second] = await sendInOrder('cancel', 'cancel');
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'This order is already CANCELLED', currentStatus: 'CANCELLED' });
    expect(committed.stock).toEqual({ 1: 10, 2: 5 });
    expect(committed.movements.filter((m) => m.movementType === 'ORDER_CANCELLED')).toHaveLength(2); // 1 per product
  });

  test('a cancelled order cannot be confirmed again, so its stock cannot be deducted a second time', async () => {
    await post('confirm');
    await post('cancel');
    const res = await post('confirm');
    expect(res.status).toBe(409);
    expect(committed.stock).toEqual({ 1: 10, 2: 5 });
  });

  test.each(['SHIPPED', 'DELIVERED'])('a %s order cannot be cancelled and its stock is untouched', async (status) => {
    committed = freshDatabase(status, { 1: 7, 2: 4 });
    const res = await post('cancel');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: `This order is ${status} and cannot be changed to CANCELLED`, currentStatus: status });
    expect(committed).toEqual(freshDatabase(status, { 1: 7, 2: 4 }));
    expect(productRepository.setStockQuantity).not.toHaveBeenCalled();
    expect(stockAdjustmentRepository.insertOrderMovement).not.toHaveBeenCalled();
  });

  test('a restore that would pass the largest stock quantity is refused as a whole', async () => {
    committed = freshDatabase('CONFIRMED', { 1: 4294967295, 2: 4 });
    const res = await post('cancel');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Restoring stock would exceed the maximum stock quantity', productIds: [1] });
    expect(committed.status).toBe('CONFIRMED');
    expect(committed.stock).toEqual({ 1: 4294967295, 2: 4 }); // product 2 was not restored either
  });

  test('a failure while restoring the second product rolls the whole cancellation back', async () => {
    committed = freshDatabase('CONFIRMED', { 1: 7, 2: 4 });
    let writes = 0;
    productRepository.setStockQuantity.mockImplementation(async (c, id, quantity) => {
      writes += 1;
      if (writes === 2) throw Object.assign(new Error('x'), { code: 'ER_BOOM' });
      working.stock[id] = quantity;
    });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post('cancel');
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(committed).toEqual(freshDatabase('CONFIRMED', { 1: 7, 2: 4 }));
  });
});

describe('ship and deliver: no stock effect', () => {
  test('ship: CONFIRMED -> SHIPPED changes the status and history only', async () => {
    committed = freshDatabase('CONFIRMED', { 1: 7, 2: 4 });
    const res = await post('ship');
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('SHIPPED');
    expect(committed.status).toBe('SHIPPED');
    expect(committed.stock).toEqual({ 1: 7, 2: 4 });
    expect(committed.movements).toEqual([]);
    expect(committed.history).toEqual([{ orderId: 12, fromStatus: 'CONFIRMED', toStatus: 'SHIPPED', adminId: 7 }]);
    expect(productRepository.lockForUpdate).not.toHaveBeenCalled();
    expect(productRepository.setStockQuantity).not.toHaveBeenCalled();
    expect(stockAdjustmentRepository.insertOrderMovement).not.toHaveBeenCalled();
  });

  test('deliver: SHIPPED -> DELIVERED changes the status and history only', async () => {
    committed = freshDatabase('SHIPPED', { 1: 7, 2: 4 });
    const res = await post('deliver');
    expect(res.status).toBe(200);
    expect(committed.status).toBe('DELIVERED');
    expect(committed.stock).toEqual({ 1: 7, 2: 4 });
    expect(committed.movements).toEqual([]);
    expect(committed.history).toEqual([{ orderId: 12, fromStatus: 'SHIPPED', toStatus: 'DELIVERED', adminId: 7 }]);
    expect(productRepository.setStockQuantity).not.toHaveBeenCalled();
  });

  test('the full happy path: confirm, ship, deliver deducts once and records three history entries', async () => {
    expect((await post('confirm')).status).toBe(200);
    expect((await post('ship')).status).toBe(200);
    expect((await post('deliver')).status).toBe(200);
    expect(committed.status).toBe('DELIVERED');
    expect(committed.stock).toEqual({ 1: 7, 2: 4 });
    expect(committed.movements).toHaveLength(2);
    expect(committed.history.map((h) => `${h.fromStatus}>${h.toStatus}`)).toEqual([
      'PENDING>CONFIRMED',
      'CONFIRMED>SHIPPED',
      'SHIPPED>DELIVERED',
    ]);
  });

  test('a failure writing the history rolls a shipment back', async () => {
    committed = freshDatabase('CONFIRMED', { 1: 7, 2: 4 });
    orderRepository.insertStatusHistory.mockRejectedValue(Object.assign(new Error('x'), { code: 'ER_BOOM' }));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post('ship');
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(committed.status).toBe('CONFIRMED');
  });
});

describe('the transition table', () => {
  const STATUSES = ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
  const ACTIONS = { confirm: 'CONFIRMED', cancel: 'CANCELLED', ship: 'SHIPPED', deliver: 'DELIVERED' };
  const ALLOWED = new Set(['PENDING>CONFIRMED', 'PENDING>CANCELLED', 'CONFIRMED>SHIPPED', 'CONFIRMED>CANCELLED', 'SHIPPED>DELIVERED']);

  // Every one of the 20 combinations of (current status, action).
  const combos = STATUSES.flatMap((from) => Object.entries(ACTIONS).map(([action, to]) => [from, action, to]));

  test.each(combos)('from %s, %s -> %s', async (from, action, to) => {
    committed = freshDatabase(from, { 1: 20, 2: 20 });
    const before = copyDatabase(committed);
    const res = await post(action);

    if (ALLOWED.has(`${from}>${to}`)) {
      expect(res.status).toBe(200);
      expect(committed.status).toBe(to);
      expect(committed.history).toEqual([{ orderId: 12, fromStatus: from, toStatus: to, adminId: 7 }]);
    } else {
      expect(res.status).toBe(409);
      expect(res.body.currentStatus).toBe(from);
      expect(committed).toEqual(before); // refused moves change nothing at all
      expect(orderRepository.insertStatusHistory).not.toHaveBeenCalled();
    }
  });

  test('the exported table matches the approved rules', () => {
    expect(orderService.ALLOWED_TRANSITIONS).toEqual({
      PENDING: ['CONFIRMED', 'CANCELLED'],
      CONFIRMED: ['SHIPPED', 'CANCELLED'],
      SHIPPED: ['DELIVERED'],
      DELIVERED: [],
      CANCELLED: [],
    });
  });

  test('only CONFIRMED and (CONFIRMED -> CANCELLED) touch stock', async () => {
    for (const [from, action, to] of combos) {
      if (!ALLOWED.has(`${from}>${to}`)) continue;
      jest.clearAllMocks();
      committed = freshDatabase(from, { 1: 20, 2: 20 });
      await post(action);
      const touchesStock = productRepository.setStockQuantity.mock.calls.length > 0;
      expect(touchesStock).toBe(to === 'CONFIRMED' || (from === 'CONFIRMED' && to === 'CANCELLED'));
    }
  });
});

describe('lock timeouts and deadlocks on status changes', () => {
  const BUSY = 'The order is busy; please try again.';
  const lockError = (code) =>
    Object.assign(new Error(`${code}: SELECT secret_column FROM orders WHERE id = 12`), {
      code,
      sqlMessage: 'secret sql text',
    });
  const BUSY_CODES = ['ER_LOCK_WAIT_TIMEOUT', 'ER_LOCK_DEADLOCK'];
  const START = { confirm: 'PENDING', cancel: 'CONFIRMED', ship: 'CONFIRMED', deliver: 'SHIPPED' };
  const TARGET = { confirm: 'CONFIRMED', cancel: 'CANCELLED', ship: 'SHIPPED', deliver: 'DELIVERED' };
  const cases = BUSY_CODES.flatMap((code) => Object.keys(START).map((action) => [code, action]));

  const sendCapturingLog = async (action) => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(action);
    const logged = spy.mock.calls.map((call) => call.join(' '));
    spy.mockRestore();
    return { res, logged };
  };

  const expectBusyAnswer = (res) => {
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('2');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ error: BUSY });
    expect(JSON.stringify(res.body)).not.toMatch(/secret|SELECT|ER_LOCK|sql/i);
  };

  test.each(cases)('%s while waiting for the order lock on /%s: 503, rolled back, nothing saved, not retried', async (code, action) => {
    committed = freshDatabase(START[action], { 1: 20, 2: 20 });
    const before = copyDatabase(committed);
    orderRepository.lockOrder.mockRejectedValue(lockError(code));

    const { res, logged } = await sendCapturingLog(action);

    expectBusyAnswer(res);
    expect(db.withTransaction).toHaveBeenCalledTimes(1); // never retried automatically
    expect(events).toEqual(['begin', 'rollback']); // rolled back, and that happened before the answer was sent
    expect(committed).toEqual(before);
    expect(logged).toEqual([`Order 12 could not be changed to ${TARGET[action]}: ${code}`]); // the code only
  });

  test.each(BUSY_CODES)('%s while waiting for a product lock during confirm: the order lock is released and nothing is saved', async (code) => {
    productRepository.lockForUpdate.mockImplementation(async (connection, id) => {
      events.push(`lock-product:${id}`);
      if (id === 2) throw lockError(code); // product 1 was already locked when product 2 times out
      return { id, stock_quantity: working.stock[id] };
    });
    const { res } = await sendCapturingLog('confirm');
    expectBusyAnswer(res);
    expect(events.filter((e) => e === 'commit' || e === 'rollback')).toEqual(['rollback']);
    expect(lockedProducts()).toEqual([1, 2]);
    expect(committed).toEqual(freshDatabase('PENDING'));
  });

  test.each(BUSY_CODES)('%s part-way through writing a confirmation discards the half-done deduction', async (code) => {
    let writes = 0;
    productRepository.setStockQuantity.mockImplementation(async (connection, id, quantity) => {
      writes += 1;
      if (writes === 2) throw lockError(code);
      working.stock[id] = quantity;
    });
    const { res } = await sendCapturingLog('confirm');
    expectBusyAnswer(res);
    expect(writes).toBe(2);
    expect(committed).toEqual(freshDatabase('PENDING'));
  });

  test.each(BUSY_CODES)('%s while restoring stock for a cancellation discards the restore', async (code) => {
    committed = freshDatabase('CONFIRMED', { 1: 7, 2: 4 });
    stockAdjustmentRepository.insertOrderMovement.mockRejectedValue(lockError(code));
    const { res } = await sendCapturingLog('cancel');
    expectBusyAnswer(res);
    expect(committed).toEqual(freshDatabase('CONFIRMED', { 1: 7, 2: 4 }));
  });

  test('after a busy answer the same request can simply be sent again and succeeds', async () => {
    orderRepository.lockOrder.mockRejectedValueOnce(lockError('ER_LOCK_DEADLOCK')); // only the first call fails

    expect((await sendCapturingLog('confirm')).res.status).toBe(503);
    const second = await post('confirm');
    expect(second.status).toBe(200);
    expect(committed.stock).toEqual({ 1: 7, 2: 4 }); // deducted once, by the successful attempt only
  });

  describe('every other database error stays a generic 500', () => {
    const OTHER = [
      ['ER_BAD_FIELD_ERROR', 'unknown column (migration 002 not applied)'],
      ['ER_NO_SUCH_TABLE', 'missing table'],
      ['ER_DUP_ENTRY', 'unique key'],
      ['ER_NO_REFERENCED_ROW_2', 'foreign key'],
      ['ER_LOCK_ABORTED', 'a similar-sounding lock error'],
      ['ER_LOCK_NOWAIT', 'a similar-sounding lock error'],
      ['ER_CON_COUNT_ERROR', 'too many connections'],
      ['PROTOCOL_CONNECTION_LOST', 'connection lost'],
      ['ETIMEDOUT', 'network timeout'],
      ['ER_QUERY_TIMEOUT', 'query timeout'],
    ];

    test.each(OTHER)('%s (%s)', async (code) => {
      orderRepository.lockOrder.mockRejectedValue(Object.assign(new Error('Deadlock found when trying to get lock; secret'), { code }));
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const res = await post('confirm');
      spy.mockRestore();

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
      expect(res.headers['retry-after']).toBeUndefined();
      expect(events).toEqual(['begin', 'rollback']);
    });

    test('an error with no code, even one whose message mentions a deadlock', async () => {
      orderRepository.lockOrder.mockRejectedValue(new Error('Deadlock found when trying to get lock; try restarting transaction'));
      const res = await post('confirm');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
      expect(res.headers['retry-after']).toBeUndefined();
    });

    test('the same lock errors are NOT mapped when creating an order (only status changes are)', async () => {
      for (const code of ['ER_LOCK_WAIT_TIMEOUT', 'ER_LOCK_DEADLOCK']) {
        orderRepository.findCustomerForOrder.mockRejectedValue(lockError(code));
        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const res = await request(app)
          .post('/api/orders')
          .set('Cookie', cookie())
          .send({ customerId: 3, items: [{ productId: 1, quantity: 1 }] });
        spy.mockRestore();
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: 'Internal server error' });
        expect(res.headers['retry-after']).toBeUndefined();
      }
    });
  });
});

describe('the order is changed but cannot be read back', () => {
  test('answers 200 with order: null and a clear message; nothing is repeated', async () => {
    orderRepository.findById.mockRejectedValue(Object.assign(new Error("SELECT email FROM customers WHERE name='Ann Lee'"), { code: 'ER_BOOM' }));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post('confirm');
    const logged = spy.mock.calls.map((call) => call.join(' ')).join('\n');
    spy.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      order: null,
      orderId: 12,
      status: 'CONFIRMED',
      detailsAvailable: false,
      message: 'Order #12 is now CONFIRMED, but its details could not be loaded. Do not repeat the action; open the order to check it.',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/Ann Lee|ann@example|SELECT|ER_BOOM/);
    expect(logged).toBe('Order 12 changed to CONFIRMED but could not be read back: ER_BOOM');
    expect(db.withTransaction).toHaveBeenCalledTimes(1);
    expect(committed.stock).toEqual({ 1: 7, 2: 4 }); // deducted exactly once
    expect(productRepository.setStockQuantity).toHaveBeenCalledTimes(2);
  });

  test('a repeat of the action after that is refused, so the stock is not deducted again', async () => {
    orderRepository.findById.mockRejectedValueOnce(new Error('x'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await post('confirm');
    spy.mockRestore();
    expect((await post('confirm')).status).toBe(409);
    expect(committed.stock).toEqual({ 1: 7, 2: 4 });
  });
});

describe('the real repository SQL (fake connection, text and parameters only)', () => {
  const orderRepo = jest.requireActual('../../src/repositories/orderRepository');
  const stockRepo = jest.requireActual('../../src/repositories/stockAdjustmentRepository');
  const sql = (connection, i = 0) => connection.query.mock.calls[i][0].replace(/\s+/g, ' ').trim();

  test('lockOrder locks the order row with FOR UPDATE on the transaction connection', async () => {
    const connection = { query: jest.fn().mockResolvedValue([[{ id: 12, status: 'PENDING' }]]) };
    expect(await orderRepo.lockOrder(connection, 12)).toEqual({ id: 12, status: 'PENDING' });
    expect(sql(connection)).toBe('SELECT id, status FROM orders WHERE id = ? LIMIT 1 FOR UPDATE');
    expect(connection.query.mock.calls[0][1]).toEqual([12]);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  test('lockOrder returns null for an unknown order', async () => {
    const connection = { query: jest.fn().mockResolvedValue([[]]) };
    expect(await orderRepo.lockOrder(connection, 404)).toBeNull();
  });

  test('listItemQuantities reads the lines lowest product id first', async () => {
    const connection = { query: jest.fn().mockResolvedValue([LINES]) };
    await orderRepo.listItemQuantities(connection, 12);
    expect(sql(connection)).toBe(
      'SELECT product_id, quantity FROM order_items WHERE order_id = ? ORDER BY product_id ASC'
    );
    expect(connection.query.mock.calls[0][1]).toEqual([12]);
  });

  test('updateStatus uses placeholders', async () => {
    const connection = { query: jest.fn().mockResolvedValue([{ affectedRows: 1 }]) };
    await orderRepo.updateStatus(connection, 12, 'CONFIRMED');
    expect(connection.query.mock.calls[0]).toEqual(['UPDATE orders SET status = ? WHERE id = ?', ['CONFIRMED', 12]]);
  });

  test('insertOrderMovement writes the order link and movement type with placeholders, on the connection only', async () => {
    const connection = { query: jest.fn().mockResolvedValue([{ insertId: 5 }]) };
    await stockRepo.insertOrderMovement(connection, {
      productId: 1,
      quantityDelta: -3,
      reason: 'Order #12 confirmed',
      adminId: 7,
      orderId: 12,
      movementType: 'ORDER_CONFIRMED',
    });
    expect(sql(connection)).toBe(
      'INSERT INTO stock_adjustments (product_id, quantity_delta, reason, admin_id, order_id, movement_type) VALUES (?, ?, ?, ?, ?, ?)'
    );
    expect(connection.query.mock.calls[0][1]).toEqual([1, -3, 'Order #12 confirmed', 7, 12, 'ORDER_CONFIRMED']);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});
