// Requests racing each other against the real MySQL TEST database (inventory_test). These exercise the row locks that the
// unit tests can only imitate: confirming the same order twice, orders competing for scarce stock, orders whose lines
// are listed in opposite order, many stock corrections at once, and a confirm racing a cancel.
// This file WRITES to the test database: every test starts from empty tables (resetTestDatabase) and the tables are
// emptied again afterwards. See tests/helpers/integrationEnv.js for the guards that refuse to run against anything but
// inventory_test.
//
// Every assertion is about an OUTCOME that must hold whichever request MySQL happens to run first (how many succeed,
// that stock never goes below zero, that history and movements agree). None depends on timing.
const { INTEGRATION_TIMEOUT, useIntegrationDatabase } = require('../helpers/integrationEnv');
const f = require('../helpers/factories');
const db = require('../helpers/dbAssert');

jest.setTimeout(INTEGRATION_TIMEOUT);

const ctx = useIntegrationDatabase();

let cat; // { customer, inactiveCustomer, p1 (stock 10), p2 (stock 5), p3 (inactive) }, rebuilt before every test
beforeEach(async () => {
  cat = await f.createCatalogue();
});

const newOrder = (...pairs) => f.createOrderViaApi(ctx.api, { customerId: cat.customer.id, items: f.lines(...pairs) });
const confirm = (orderId) => f.doAction(ctx.api, orderId, 'confirm');
const statuses = (results) => results.map((res) => res.status).sort((a, b) => a - b);

describe('CC-1: the same order confirmed twice at once', () => {
  test('CC-1 exactly one confirmation wins: one deduction, one history row, one 409', async () => {
    const order = await newOrder([cat.p1, 3]);

    const results = await Promise.all([confirm(order.id), confirm(order.id)]);

    expect(statuses(results)).toEqual([200, 409]);
    const loser = results.find((res) => res.status === 409);
    expect(loser.body).toMatchObject({ error: 'This order is already CONFIRMED', currentStatus: 'CONFIRMED' });
    expect(await db.productStock(cat.p1.id)).toBe(7); // deducted once, not twice
    expect(await db.movementsForOrder(order.id)).toHaveLength(1);
    expect((await db.orderHistory(order.id)).map((h) => h.toStatus)).toEqual(['PENDING', 'CONFIRMED']);
  });
});

describe('CC-2: two orders competing for the last of the stock', () => {
  test('CC-2 only one of them can be confirmed, and stock never goes below zero', async () => {
    await f.setStock(cat.p1.id, 3);
    const first = await newOrder([cat.p1, 2]);
    const second = await newOrder([cat.p1, 2]);

    const results = await Promise.all([confirm(first.id), confirm(second.id)]);

    expect(statuses(results)).toEqual([200, 409]);
    const loser = results.find((res) => res.status === 409);
    expect(loser.body.error).toBe('Not enough stock to confirm this order');
    expect(loser.body.shortages).toEqual([{ productId: cat.p1.id, requested: 2, available: 1 }]);
    expect(await db.productStock(cat.p1.id)).toBe(1);
    const rows = [...(await db.movementsForOrder(first.id)), ...(await db.movementsForOrder(second.id))];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ quantityDelta: -2, movementType: 'ORDER_CONFIRMED' });
    const finalStatuses = [(await db.orderRow(first.id)).status, (await db.orderRow(second.id)).status].sort();
    expect(finalStatuses).toEqual(['CONFIRMED', 'PENDING']);
  });
});

describe('CC-3: orders whose lines are listed in opposite order', () => {
  test('CC-3 confirming them together never deadlocks, over several rounds', async () => {
    await f.setStock(cat.p1.id, 100);
    await f.setStock(cat.p2.id, 100);
    const rounds = 8;

    for (let round = 0; round < rounds; round += 1) {
      const a = await newOrder([cat.p1, 1], [cat.p2, 1]); // product 1 first
      const b = await newOrder([cat.p2, 1], [cat.p1, 1]); // product 2 first

      const results = await Promise.all([confirm(a.id), confirm(b.id)]);

      expect([round, statuses(results)]).toEqual([round, [200, 200]]); // no 503 (busy) or 500 (deadlock)
    }
    expect(await db.productStock(cat.p1.id)).toBe(100 - 2 * rounds);
    expect(await db.productStock(cat.p2.id)).toBe(100 - 2 * rounds);
    expect(await db.countRows('stock_adjustments')).toBe(4 * rounds);
  });
});

describe('CC-4: many stock corrections at once', () => {
  test('CC-4 six removals of 1 against a stock of 4: exactly four succeed and stock ends at 0, never negative', async () => {
    await f.setStock(cat.p1.id, 4);

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => ctx.api.post(`/api/products/${cat.p1.id}/stock-adjustments`, { delta: -1, reason: `removal ${i}` }))
    );

    expect(statuses(results)).toEqual([201, 201, 201, 201, 409, 409]);
    for (const refused of results.filter((res) => res.status === 409)) {
      expect(refused.body).toMatchObject({ fields: ['delta'], currentStock: 0 });
    }
    expect(await db.productStock(cat.p1.id)).toBe(0);
    const rows = await db.movementsForProduct(cat.p1.id);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.quantityDelta === -1 && row.movementType === 'MANUAL')).toBe(true);
  });
});

describe('CC-5: a confirmation racing a cancellation of the same order', () => {
  test('CC-5 whichever runs first, the order ends cancelled and stock, history and movements agree', async () => {
    const order = await newOrder([cat.p1, 3]);

    const [confirmed, cancelled] = await Promise.all([confirm(order.id), f.doAction(ctx.api, order.id, 'cancel')]);

    // The cancellation always succeeds (from PENDING, or from CONFIRMED after the confirmation).
    expect(cancelled.status).toBe(200);
    expect([200, 409]).toContain(confirmed.status);
    expect((await db.orderRow(order.id)).status).toBe('CANCELLED');
    expect(await db.productStock(cat.p1.id)).toBe(10); // back to the start either way

    const movements = await db.movementsForOrder(order.id);
    expect(movements.reduce((sum, row) => sum + row.quantityDelta, 0)).toBe(0); // deductions and restores cancel out
    const history = (await db.orderHistory(order.id)).map((h) => h.toStatus);
    if (confirmed.status === 200) {
      // The confirmation ran first: it deducted, then the cancellation restored.
      expect(history).toEqual(['PENDING', 'CONFIRMED', 'CANCELLED']);
      expect(movements.map((row) => row.movementType)).toEqual(['ORDER_CONFIRMED', 'ORDER_CANCELLED']);
    } else {
      // The cancellation ran first: the confirmation was refused and stock never moved.
      expect(history).toEqual(['PENDING', 'CANCELLED']);
      expect(movements).toEqual([]);
    }
  });
});
