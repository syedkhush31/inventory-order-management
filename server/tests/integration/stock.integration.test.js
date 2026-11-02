// Stock against the real MySQL TEST database (inventory_test): what confirming and cancelling orders does to stock, the
// stock_adjustments history (movements caused by orders and manual corrections), and the rules around them.
// This file WRITES to the test database: every test starts from empty tables (resetTestDatabase) and the tables are
// emptied again afterwards. See tests/helpers/integrationEnv.js for the guards that refuse to run against anything but
// inventory_test.
//
// Not covered here (planned for a later stage): two requests racing for the same stock.
const { INTEGRATION_TIMEOUT, query, useIntegrationDatabase } = require('../helpers/integrationEnv');
const f = require('../helpers/factories');
const db = require('../helpers/dbAssert');
const { client, cookieFor } = require('../helpers/http');
const { backdate, minutesAfter } = require('../helpers/clock');

jest.setTimeout(INTEGRATION_TIMEOUT);

const ctx = useIntegrationDatabase();

let cat; // { customer, inactiveCustomer, p1 (stock 10), p2 (stock 5), p3 (inactive, stock 5) }, rebuilt before every test
beforeEach(async () => {
  cat = await f.createCatalogue();
});

const MAX_STOCK = 4294967295;

const newOrder = (...pairs) => f.createOrderViaApi(ctx.api, { customerId: cat.customer.id, items: f.lines(...pairs) });
const confirm = (orderId) => f.doAction(ctx.api, orderId, 'confirm');
const cancel = (orderId) => f.doAction(ctx.api, orderId, 'cancel');
const adjust = (api, productId, body) => api.post(`/api/products/${productId}/stock-adjustments`, body);
const withoutId = ({ id, ...rest }) => rest; // movement rows are compared without their database id

// ----------------------------------------------------------------------------------------- confirming an order
describe('STK-1 to STK-4: confirming an order', () => {
  test('STK-1 confirming deducts every line and records one ORDER_CONFIRMED movement per line', async () => {
    const order = await newOrder([cat.p1, 3], [cat.p2, 2]);

    const res = await confirm(order.id);

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('CONFIRMED');
    expect(await db.productStock(cat.p1.id)).toBe(7);
    expect(await db.productStock(cat.p2.id)).toBe(3);
    expect((await db.movementsForOrder(order.id)).map(withoutId)).toEqual([
      { productId: cat.p1.id, quantityDelta: -3, reason: `Order #${order.id} confirmed`, adminId: ctx.admin.id, orderId: order.id, movementType: 'ORDER_CONFIRMED' },
      { productId: cat.p2.id, quantityDelta: -2, reason: `Order #${order.id} confirmed`, adminId: ctx.admin.id, orderId: order.id, movementType: 'ORDER_CONFIRMED' },
    ]);
    expect((await db.orderHistory(order.id)).map((h) => h.toStatus)).toEqual(['PENDING', 'CONFIRMED']);
  });

  test('STK-2 not enough stock: 409 with the shortage, and the order, stock and history are untouched', async () => {
    await f.setStock(cat.p1.id, 2);
    const order = await newOrder([cat.p1, 3]); // creating the order does not check stock

    const res = await confirm(order.id);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'Not enough stock to confirm this order',
      shortages: [{ productId: cat.p1.id, requested: 3, available: 2 }],
    });
    expect((await db.orderRow(order.id)).status).toBe('PENDING');
    expect(await db.productStock(cat.p1.id)).toBe(2);
    expect(await db.movementsForOrder(order.id)).toEqual([]);
    expect(await db.orderHistory(order.id)).toHaveLength(1); // only the creation record
  });

  test('STK-3 if one product is short, no product is deducted (all or nothing)', async () => {
    await f.setStock(cat.p2.id, 1);
    const order = await newOrder([cat.p1, 2], [cat.p2, 5]);

    const res = await confirm(order.id);

    expect(res.status).toBe(409);
    expect(res.body.shortages).toEqual([{ productId: cat.p2.id, requested: 5, available: 1 }]); // only the short product
    expect(await db.productStock(cat.p1.id)).toBe(10); // enough stock, still not deducted
    expect(await db.productStock(cat.p2.id)).toBe(1);
    expect(await db.movementsForOrder(order.id)).toEqual([]);
    expect((await db.orderRow(order.id)).status).toBe('PENDING');
  });

  test('STK-4 an order for exactly the stock on hand confirms and leaves 0, never below', async () => {
    await f.setStock(cat.p1.id, 3);
    const order = await newOrder([cat.p1, 3]);

    const res = await confirm(order.id);

    expect(res.status).toBe(200);
    expect(await db.productStock(cat.p1.id)).toBe(0);
  });

  test('STK-11 an order can still be confirmed after one of its products was deactivated', async () => {
    const order = await newOrder([cat.p1, 4]);
    const off = await ctx.api.post(`/api/products/${cat.p1.id}/deactivate`);
    expect(off.status).toBe(200);

    const res = await confirm(order.id);

    expect(res.status).toBe(200);
    expect(await db.productStock(cat.p1.id)).toBe(6);
  });
});

// ----------------------------------------------------------------------------------------- cancelling an order
describe('STK-5 to STK-7: cancelling an order', () => {
  test('STK-5 cancelling a CONFIRMED order puts the stock back and records ORDER_CANCELLED movements', async () => {
    const order = await newOrder([cat.p1, 3], [cat.p2, 2]);
    expect((await confirm(order.id)).status).toBe(200);

    const res = await cancel(order.id);

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('CANCELLED');
    expect(await db.productStock(cat.p1.id)).toBe(10);
    expect(await db.productStock(cat.p2.id)).toBe(5);
    const reason = (verb) => `Order #${order.id} ${verb}`;
    expect((await db.movementsForOrder(order.id)).map(withoutId)).toEqual([
      { productId: cat.p1.id, quantityDelta: -3, reason: reason('confirmed'), adminId: ctx.admin.id, orderId: order.id, movementType: 'ORDER_CONFIRMED' },
      { productId: cat.p1.id, quantityDelta: 3, reason: reason('cancelled'), adminId: ctx.admin.id, orderId: order.id, movementType: 'ORDER_CANCELLED' },
      { productId: cat.p2.id, quantityDelta: -2, reason: reason('confirmed'), adminId: ctx.admin.id, orderId: order.id, movementType: 'ORDER_CONFIRMED' },
      { productId: cat.p2.id, quantityDelta: 2, reason: reason('cancelled'), adminId: ctx.admin.id, orderId: order.id, movementType: 'ORDER_CANCELLED' },
    ]);
  });

  test('STK-6 cancelling a PENDING order changes no stock and writes no movement', async () => {
    const order = await newOrder([cat.p1, 3], [cat.p2, 2]);

    const res = await cancel(order.id);

    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('CANCELLED');
    expect(await db.productStock(cat.p1.id)).toBe(10);
    expect(await db.productStock(cat.p2.id)).toBe(5);
    expect(await db.movementsForOrder(order.id)).toEqual([]);
    expect(await db.countRows('stock_adjustments')).toBe(0);
  });

  test('STK-7 a restore that would pass the largest stock quantity is refused with 409 and nothing changes', async () => {
    await f.setStock(cat.p1.id, 3);
    const order = await newOrder([cat.p1, 3]);
    expect((await confirm(order.id)).status).toBe(200); // stock is now 0
    await f.setStock(cat.p1.id, MAX_STOCK - 1); // restoring 3 would pass the column maximum
    const movementsBefore = await db.movementsForOrder(order.id);

    const res = await cancel(order.id);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'Restoring stock would exceed the maximum stock quantity',
      productIds: [cat.p1.id],
    });
    expect((await db.orderRow(order.id)).status).toBe('CONFIRMED');
    expect(await db.productStock(cat.p1.id)).toBe(MAX_STOCK - 1);
    expect(await db.movementsForOrder(order.id)).toEqual(movementsBefore);
    expect((await db.orderHistory(order.id)).map((h) => h.toStatus)).toEqual(['PENDING', 'CONFIRMED']);
  });
});

// ------------------------------------------------------------------------------------ no duplicate movements
describe('STK-8 to STK-10: no duplicate movements', () => {
  test('STK-8 confirming twice deducts once', async () => {
    const order = await newOrder([cat.p1, 3]);
    expect((await confirm(order.id)).status).toBe(200);
    const movementsAfterFirst = await db.movementsForOrder(order.id);

    const again = await confirm(order.id);

    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: 'This order is already CONFIRMED', currentStatus: 'CONFIRMED' });
    expect(await db.productStock(cat.p1.id)).toBe(7); // deducted once
    expect(await db.movementsForOrder(order.id)).toEqual(movementsAfterFirst);
  });

  test('STK-9 cancelling twice restores once', async () => {
    const order = await newOrder([cat.p1, 3]);
    expect((await confirm(order.id)).status).toBe(200);
    expect((await cancel(order.id)).status).toBe(200);
    const movementsAfterFirst = await db.movementsForOrder(order.id);

    const again = await cancel(order.id);

    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: 'This order is already CANCELLED', currentStatus: 'CANCELLED' });
    expect(await db.productStock(cat.p1.id)).toBe(10); // restored once, not twice
    expect(await db.movementsForOrder(order.id)).toEqual(movementsAfterFirst);
  });

  test('STK-10 the database itself refuses a second movement of the same kind for one order and product', async () => {
    const order = await newOrder([cat.p1, 3]);
    expect((await confirm(order.id)).status).toBe(200);
    const before = await db.movementsForProduct(cat.p1.id);

    // A second ORDER_CONFIRMED row for the same (order, product) breaks uq_stock_adjustments_order_product_type.
    await expect(
      query(
        `INSERT INTO stock_adjustments (product_id, quantity_delta, reason, admin_id, order_id, movement_type)
         VALUES (?, ?, ?, ?, ?, 'ORDER_CONFIRMED')`,
        [cat.p1.id, -3, 'duplicate attempt', ctx.admin.id, order.id]
      )
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    expect(await db.movementsForProduct(cat.p1.id)).toEqual(before);

    // Manual corrections have no order, and NULL values never collide in a unique key: many are allowed.
    for (let i = 0; i < 2; i += 1) {
      await query('INSERT INTO stock_adjustments (product_id, quantity_delta, reason, admin_id) VALUES (?, ?, ?, ?)', [
        cat.p1.id,
        1,
        'same manual correction',
        ctx.admin.id,
      ]);
    }
    expect(await db.movementsForProduct(cat.p1.id)).toHaveLength(before.length + 2);
  });
});

// ------------------------------------------------------------------------------------------ manual adjustments
describe('STK-12 to STK-14: manual stock adjustments', () => {
  test('STK-12 adding and removing stock updates the product and writes one MANUAL history row each', async () => {
    const add = await adjust(ctx.api, cat.p1.id, { delta: 5, reason: '  Recount after delivery  ' });

    expect(add.status).toBe(201);
    expect(add.body.product).toMatchObject({ id: cat.p1.id, stockQuantity: 15 });
    expect(add.body.adjustment).toMatchObject({
      productId: cat.p1.id,
      quantityDelta: 5,
      reason: 'Recount after delivery', // trimmed
      adminId: ctx.admin.id,
    });

    const remove = await adjust(ctx.api, cat.p1.id, { delta: -4, reason: 'Damaged in storage' });
    expect(remove.status).toBe(201);
    expect(remove.body.product.stockQuantity).toBe(11);

    expect(await db.productStock(cat.p1.id)).toBe(11);
    expect((await db.movementsForProduct(cat.p1.id)).map(withoutId)).toEqual([
      { productId: cat.p1.id, quantityDelta: 5, reason: 'Recount after delivery', adminId: ctx.admin.id, orderId: null, movementType: 'MANUAL' },
      { productId: cat.p1.id, quantityDelta: -4, reason: 'Damaged in storage', adminId: ctx.admin.id, orderId: null, movementType: 'MANUAL' },
    ]);
  });

  test('STK-13 a result below 0 or above the maximum is refused with 409 and nothing is written', async () => {
    const tooLow = await adjust(ctx.api, cat.p1.id, { delta: -11, reason: 'More than we have' });
    expect(tooLow.status).toBe(409);
    expect(tooLow.body).toMatchObject({ fields: ['delta'], currentStock: 10 });
    expect(await db.productStock(cat.p1.id)).toBe(10);

    await f.setStock(cat.p1.id, MAX_STOCK - 5);
    const tooHigh = await adjust(ctx.api, cat.p1.id, { delta: 10, reason: 'Past the column maximum' });
    expect(tooHigh.status).toBe(409);
    expect(tooHigh.body).toMatchObject({ fields: ['delta'], currentStock: MAX_STOCK - 5 });
    expect(await db.productStock(cat.p1.id)).toBe(MAX_STOCK - 5);

    // Exactly to 0 and exactly to the maximum are fine.
    const toMax = await adjust(ctx.api, cat.p1.id, { delta: 5, reason: 'Exactly the maximum' });
    expect(toMax.status).toBe(201);
    expect(toMax.body.product.stockQuantity).toBe(MAX_STOCK);

    expect(await db.countRows('stock_adjustments')).toBe(1); // only the accepted one
  });

  const INVALID_BODIES = [
    ['delta 0', { delta: 0, reason: 'x' }],
    ['a fractional delta', { delta: 1.5, reason: 'x' }],
    ['a delta given as text', { delta: '5', reason: 'x' }],
    ['a delta beyond the INT range', { delta: 2147483648, reason: 'x' }],
    ['no delta', { reason: 'x' }],
    ['no reason', { delta: 1 }],
    ['a blank reason', { delta: 1, reason: '   ' }],
    ['a 256-character reason', { delta: 1, reason: 'x'.repeat(256) }],
    ['a reason with a control character', { delta: 1, reason: 'bad\u0007reason' }],
    ['a stockQuantity property', { delta: 1, reason: 'x', stockQuantity: 99 }],
    ['an adminId property', { delta: 1, reason: 'x', adminId: 999 }],
  ];

  test.each(INVALID_BODIES)('STK-13 rejects %s with 400 and nothing is written', async (_name, body) => {
    const res = await adjust(ctx.api, cat.p1.id, body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
    expect(await db.productStock(cat.p1.id)).toBe(10);
    expect(await db.countRows('stock_adjustments')).toBe(0);
  });

  test('STK-13 an unknown product is 404 and an invalid id is 400', async () => {
    const missing = await adjust(ctx.api, 999999999, { delta: 1, reason: 'x' });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Product not found' });

    const bad = await adjust(ctx.api, 'abc', { delta: 1, reason: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ fields: ['id'] });
    expect(await db.countRows('stock_adjustments')).toBe(0);
  });

  test('STK-14 an inactive product can still be corrected', async () => {
    const up = await adjust(ctx.api, cat.p3.id, { delta: 1, reason: 'Found one' });
    expect(up.status).toBe(201);
    expect(up.body.product).toMatchObject({ id: cat.p3.id, isActive: false, stockQuantity: 6 });

    const down = await adjust(ctx.api, cat.p3.id, { delta: -6, reason: 'Written off' });
    expect(down.status).toBe(201);
    expect(await db.productStock(cat.p3.id)).toBe(0);
    expect(await db.movementsForProduct(cat.p3.id)).toHaveLength(2);
  });
});

// ------------------------------------------------------------------------------------------------ stock history
describe('STK-15: the stock history of a product', () => {
  test('STK-15 lists manual and order movements newest first, paged, with only the documented fields', async () => {
    expect((await adjust(ctx.api, cat.p1.id, { delta: 5, reason: 'Recount A' })).status).toBe(201); // 10 -> 15
    expect((await adjust(ctx.api, cat.p1.id, { delta: -2, reason: 'Damaged' })).status).toBe(201); // -> 13
    const order = await newOrder([cat.p1, 3]);
    expect((await confirm(order.id)).status).toBe(200); // -> 10
    expect((await adjust(ctx.api, cat.p1.id, { delta: 1, reason: 'Found' })).status).toBe(201); // -> 11

    // Give the four rows distinct, known times (oldest = first created), so the order does not depend on the clock.
    const rows = await db.movementsForProduct(cat.p1.id);
    expect(rows).toHaveLength(4);
    for (let i = 0; i < rows.length; i += 1) {
      await backdate('stock_adjustments', rows[i].id, minutesAfter(i));
    }

    const page1 = await ctx.api.get(`/api/products/${cat.p1.id}/stock-adjustments?pageSize=3&page=1`);
    expect(page1.status).toBe(200);
    expect(page1.body).toMatchObject({ page: 1, pageSize: 3, total: 4, totalPages: 2 });
    expect(page1.body.items.map((item) => [item.reason, item.quantityDelta])).toEqual([
      ['Found', 1],
      [`Order #${order.id} confirmed`, -3],
      ['Damaged', -2],
    ]);
    for (const item of page1.body.items) {
      expect(Object.keys(item).sort()).toEqual(['adminId', 'createdAt', 'id', 'productId', 'quantityDelta', 'reason']);
      expect(item.adminId).toBe(ctx.admin.id);
      expect(item.productId).toBe(cat.p1.id);
    }

    const page2 = await ctx.api.get(`/api/products/${cat.p1.id}/stock-adjustments?pageSize=3&page=2`);
    expect(page2.body.items.map((item) => item.reason)).toEqual(['Recount A']);

    const defaults = await ctx.api.get(`/api/products/${cat.p1.id}/stock-adjustments`);
    expect(defaults.body.pageSize).toBe(10);
    expect(defaults.body.items).toHaveLength(4);
  });

  test('STK-15 a product with no corrections has an empty history, an unknown product is 404, bad paging is 400', async () => {
    const empty = await ctx.api.get(`/api/products/${cat.p2.id}/stock-adjustments`);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ items: [], total: 0, totalPages: 0 });

    const missing = await ctx.api.get('/api/products/999999999/stock-adjustments');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Product not found' });

    for (const bad of ['page=0', 'pageSize=0', 'pageSize=101', 'page=abc']) {
      const res = await ctx.api.get(`/api/products/${cat.p1.id}/stock-adjustments?${bad}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid request');
    }
    const badId = await ctx.api.get('/api/products/abc/stock-adjustments');
    expect(badId.status).toBe(400);
  });
});

// ------------------------------------------------------------------------------------------------ who did it
describe('STK-16: the administrator is always the signed-in one', () => {
  test('STK-16 a second administrator\'s corrections and order movements carry their own id', async () => {
    const other = await f.createAdmin({ passwordHash: ctx.passwordHash });
    const otherApi = client(ctx.app, cookieFor(other));

    const manual = await adjust(otherApi, cat.p1.id, { delta: 2, reason: 'Counted by the second administrator' });
    expect(manual.status).toBe(201);
    expect(manual.body.adjustment.adminId).toBe(other.id);

    const order = await newOrder([cat.p1, 1]); // created by the first administrator
    const confirmedByOther = await f.doAction(otherApi, order.id, 'confirm');
    expect(confirmedByOther.status).toBe(200);

    const [manualRow] = (await db.movementsForProduct(cat.p1.id)).filter((m) => m.movementType === 'MANUAL');
    expect(manualRow.adminId).toBe(other.id);
    expect((await db.movementsForOrder(order.id)).map((m) => m.adminId)).toEqual([other.id]);
    expect(await db.orderHistory(order.id)).toEqual([
      { fromStatus: null, toStatus: 'PENDING', changedByAdminId: ctx.admin.id },
      { fromStatus: 'PENDING', toStatus: 'CONFIRMED', changedByAdminId: other.id },
    ]);
  });
});
