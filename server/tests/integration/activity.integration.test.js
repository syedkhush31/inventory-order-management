// The Activity feed against the real MySQL TEST database (inventory_test): the UNION of order history, manual stock
// corrections and the audit log, with its filters, search, date range and paging.
// This file WRITES to the test database: every test starts from empty tables (resetTestDatabase) and the tables are
// emptied again afterwards. See tests/helpers/integrationEnv.js for the guards that refuse to run against anything but
// inventory_test.
//
// Timestamps have one-second resolution, so rows created in the same second tie. Within one source a tie is broken by
// id (newest first); across sources by source (order, then stock, then audit). Tests that compare the order of events
// across sources give the rows exact times with backdate().
const crypto = require('crypto');
const { INTEGRATION_TIMEOUT, useIntegrationDatabase } = require('../helpers/integrationEnv');
const f = require('../helpers/factories');
const db = require('../helpers/dbAssert');
const { client, cookieFor, cookieFromResponse } = require('../helpers/http');
const { backdate, minutesAfter } = require('../helpers/clock');

jest.setTimeout(INTEGRATION_TIMEOUT);

const ctx = useIntegrationDatabase();

let cat; // { customer, inactiveCustomer, p1 (stock 10), p2 (stock 5), p3 (inactive) }, rebuilt before every test
beforeEach(async () => {
  cat = await f.createCatalogue();
});

// GET /api/activity with the given query parameters; expects a 200 and returns the body.
async function activity(params = {}, api = ctx.api) {
  const res = await api.get(`/api/activity?${new URLSearchParams({ pageSize: '100', ...params }).toString()}`);
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  return res.body;
}
const types = (body) => body.items.map((item) => item.type);
const sorted = (list) => [...list].sort();
const newOrder = (...pairs) => f.createOrderViaApi(ctx.api, { customerId: cat.customer.id, items: f.lines(...pairs) });
const adjust = (api, productId, body) => api.post(`/api/products/${productId}/stock-adjustments`, body);
const actorOf = (admin, displayName = null) => ({ id: admin.id, email: admin.email, displayName });

// -------------------------------------------------------------------------------------------- order and stock events
describe('ACT-1 / ACT-2: order and stock events', () => {
  test('ACT-1 an order\'s life appears as created, confirmed and cancelled, with the stock movements inside the events', async () => {
    const order = await newOrder([cat.p1, 3]);
    expect((await f.doAction(ctx.api, order.id, 'confirm')).status).toBe(200);
    expect((await f.doAction(ctx.api, order.id, 'cancel')).status).toBe(200);

    const body = await activity({ type: 'order' });

    expect(types(body)).toEqual(['ORDER_CANCELLED', 'ORDER_CONFIRMED', 'ORDER_CREATED']); // newest first
    expect(body).toMatchObject({ page: 1, pageSize: 100, total: 3, totalPages: 1 });
    const [cancelled, confirmed, created] = body.items;
    for (const item of body.items) {
      expect(item.id).toMatch(/^order-\d+$/);
      expect(item.actor).toEqual(actorOf(ctx.admin));
      expect(item.entity).toEqual({ type: 'order', id: order.id, label: `Order #${order.id}` });
      expect(typeof item.occurredAt).toBe('string');
    }
    const common = { customerName: 'Ann Example', totalAmount: '30.00' };
    expect(created.details).toEqual({ ...common, fromStatus: null, toStatus: 'PENDING', stockMovements: [] });
    expect(confirmed.details).toEqual({
      ...common,
      fromStatus: 'PENDING',
      toStatus: 'CONFIRMED',
      stockMovements: [{ productId: cat.p1.id, sku: 'P-ONE', productName: 'Product One', quantityDelta: -3 }],
    });
    expect(cancelled.details).toEqual({
      ...common,
      fromStatus: 'CONFIRMED',
      toStatus: 'CANCELLED',
      stockMovements: [{ productId: cat.p1.id, sku: 'P-ONE', productName: 'Product One', quantityDelta: 3 }],
    });

    // The order's stock movements are shown inside these events and never as events of their own.
    expect((await activity({ type: 'stock' })).total).toBe(0);
    expect((await activity({ type: 'all' })).total).toBe(3);
  });

  test('ACT-2 a manual correction is one STOCK_ADJUSTED event; the movements caused by orders are not', async () => {
    expect((await adjust(ctx.api, cat.p1.id, { delta: 5, reason: 'Recount' })).status).toBe(201);
    const order = await newOrder([cat.p1, 3]);
    expect((await f.doAction(ctx.api, order.id, 'confirm')).status).toBe(200);

    const stock = await activity({ type: 'stock' });

    expect(stock.total).toBe(1);
    expect(stock.items[0]).toMatchObject({
      type: 'STOCK_ADJUSTED',
      actor: actorOf(ctx.admin),
      entity: { type: 'product', id: cat.p1.id, label: 'P-ONE — Product One' },
      details: { productId: cat.p1.id, sku: 'P-ONE', productName: 'Product One', quantityDelta: 5, reason: 'Recount' },
    });
    expect(stock.items[0].id).toMatch(/^stock-\d+$/);
    expect(sorted(types(await activity({ type: 'all' })))).toEqual(['ORDER_CONFIRMED', 'ORDER_CREATED', 'STOCK_ADJUSTED']);
  });
});

// ------------------------------------------------------------------------------------- product and customer events
describe('ACT-3 / ACT-4 / ACT-12: product and customer changes', () => {
  test('ACT-3 product events record what really changed; unchanged edits and repeated toggles are not events', async () => {
    const created = await ctx.api.post('/api/products', { sku: 'ACT-SKU', name: 'Activity Product', price: '12.5', stockQuantity: 3 });
    expect(created.status).toBe(201);
    const id = created.body.product.id;
    const patch = (body) => ctx.api.patch(`/api/products/${id}`, body);

    expect((await patch({ price: '15.00' })).status).toBe(200);
    expect((await patch({ price: '15.0' })).status).toBe(200); // the same price written differently: no change
    expect((await patch({ sku: 'ACT-NEW', name: 'Activity Renamed' })).status).toBe(200);
    expect((await patch({ name: 'Activity Renamed' })).status).toBe(200); // no change
    expect((await ctx.api.post(`/api/products/${id}/deactivate`)).status).toBe(200);
    expect((await ctx.api.post(`/api/products/${id}/deactivate`)).status).toBe(200); // already inactive: no event
    expect((await ctx.api.post(`/api/products/${id}/reactivate`)).status).toBe(200);

    const body = await activity({ type: 'product' });

    expect(types(body)).toEqual(['PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED', 'PRODUCT_UPDATED', 'PRODUCT_UPDATED', 'PRODUCT_CREATED']);
    expect(body.items.map((item) => item.details)).toEqual([
      null,
      null,
      { changedFields: ['sku', 'name'] }, // the old and new text are not recorded, only that they changed
      { changedFields: ['price'], changes: { price: { from: '12.50', to: '15.00' } } },
      { price: '12.50' },
    ]);
    // ACT-12: the label always shows the product's CURRENT sku and name.
    for (const item of body.items) {
      expect(item.entity).toEqual({ type: 'product', id, label: 'ACT-NEW — Activity Renamed' });
      expect(item.actor).toEqual(actorOf(ctx.admin));
      expect(item.id).toMatch(/^audit-\d+$/);
    }
    expect((await activity({ type: 'customer' })).total).toBe(0);
  });

  test('ACT-4 customer events record only which fields changed', async () => {
    const created = await ctx.api.post('/api/customers', {
      name: 'Act Customer',
      email: 'act@example.test',
      phone: '555-0100',
      address: '1 Test Street',
    });
    expect(created.status).toBe(201);
    const id = created.body.customer.id;
    const patch = (body) => ctx.api.patch(`/api/customers/${id}`, body);

    expect((await patch({ name: 'Act Renamed', phone: null })).status).toBe(200);
    expect((await patch({ name: 'Act Renamed' })).status).toBe(200); // no change
    expect((await patch({ address: '2 New Street' })).status).toBe(200);
    expect((await ctx.api.post(`/api/customers/${id}/deactivate`)).status).toBe(200);
    expect((await ctx.api.post(`/api/customers/${id}/deactivate`)).status).toBe(200); // already inactive: no event
    expect((await ctx.api.post(`/api/customers/${id}/reactivate`)).status).toBe(200);

    const body = await activity({ type: 'customer' });

    expect(types(body)).toEqual(['CUSTOMER_ACTIVATED', 'CUSTOMER_DEACTIVATED', 'CUSTOMER_UPDATED', 'CUSTOMER_UPDATED', 'CUSTOMER_CREATED']);
    expect(body.items.map((item) => item.details)).toEqual([
      null,
      null,
      { changedFields: ['address'] },
      { changedFields: ['name', 'phone'] },
      null,
    ]);
    for (const item of body.items) {
      expect(item.entity).toEqual({ type: 'customer', id, label: 'Act Renamed' }); // the current name
    }
    expect((await activity({ type: 'product' })).total).toBe(0);
  });
});

// --------------------------------------------------------------------------------------- account and settings
describe('ACT-5 / ACT-6: account and settings events', () => {
  test('ACT-5 profile and password changes are events that name fields, never values', async () => {
    const password = crypto.randomBytes(12).toString('hex');
    expect((await ctx.api.patch('/api/account/profile', { displayName: 'Activity Admin' })).status).toBe(200);
    expect((await ctx.api.patch('/api/account/profile', { email: 'renamed.admin@example.test', currentPassword: ctx.password })).status).toBe(200);
    const both = await ctx.api.patch('/api/account/profile', {
      displayName: 'Both Changed',
      email: 'both.admin@example.test',
      currentPassword: ctx.password,
    });
    expect(both.status).toBe(200);
    const changed = await ctx.api.post('/api/account/password', { currentPassword: ctx.password, newPassword: password });
    expect(changed.status).toBe(200);
    const fresh = client(ctx.app, cookieFromResponse(changed)); // the old cookie ended with the password change

    const body = await activity({ type: 'account' }, fresh);

    expect(types(body)).toEqual([
      'ACCOUNT_PASSWORD_CHANGED',
      'ACCOUNT_PROFILE_UPDATED',
      'ACCOUNT_PROFILE_UPDATED',
      'ACCOUNT_PROFILE_UPDATED',
    ]);
    expect(body.items.map((item) => item.details)).toEqual([
      null,
      { changedFields: ['displayName', 'email'] },
      { changedFields: ['email'] },
      { changedFields: ['displayName'] },
    ]);
    for (const item of body.items) {
      expect(item.entity).toEqual({ type: 'account', id: ctx.admin.id, label: 'Administrator account' });
      // The actor is shown as the account is NOW (its current email and display name).
      expect(item.actor).toEqual({ id: ctx.admin.id, email: 'both.admin@example.test', displayName: 'Both Changed' });
    }
  });

  test('ACT-6 a settings change is an event with the old and new value; saving the same value is not', async () => {
    expect((await ctx.api.patch('/api/settings', { lowStockThreshold: 7 })).status).toBe(200);
    expect((await ctx.api.patch('/api/settings', { lowStockThreshold: 7 })).status).toBe(200); // no change
    expect((await ctx.api.patch('/api/settings', { lowStockThreshold: 9 })).status).toBe(200);

    const body = await activity({ type: 'settings' });

    expect(types(body)).toEqual(['SETTINGS_UPDATED', 'SETTINGS_UPDATED']);
    expect(body.items.map((item) => item.details)).toEqual([
      { key: 'low_stock_threshold', from: 7, to: 9 },
      { key: 'low_stock_threshold', from: 5, to: 7 },
    ]);
    for (const item of body.items) {
      expect(item.entity).toEqual({ type: 'settings', id: null, label: 'Settings' });
    }
  });
});

// ------------------------------------------------------------------------------------------------ ordering
describe('ACT-7: merging the three sources', () => {
  test('ACT-7 type=all lists order, stock and audit events together, newest first, with ties broken by source', async () => {
    const order = await newOrder([cat.p1, 1]);
    expect((await adjust(ctx.api, cat.p1.id, { delta: 1, reason: 'Recount' })).status).toBe(201);
    expect((await ctx.api.post('/api/products', { sku: 'ACT7', name: 'Seven', price: '1.00' })).status).toBe(201);
    const orderEvent = `order-${(await db.historyIds(order.id))[0]}`;
    const stockEvent = `stock-${(await db.movementsForProduct(cat.p1.id))[0].id}`;
    const auditEvent = `audit-${(await db.auditRows())[0].id}`;
    const [, orderRowId] = orderEvent.split('-');
    const [, stockRowId] = stockEvent.split('-');
    const [, auditRowId] = auditEvent.split('-');

    await backdate('order_status_history', Number(orderRowId), minutesAfter(30));
    await backdate('audit_log', Number(auditRowId), minutesAfter(20));
    await backdate('stock_adjustments', Number(stockRowId), minutesAfter(10));
    expect((await activity({ type: 'all' })).items.map((item) => item.id)).toEqual([orderEvent, auditEvent, stockEvent]);

    // At the same instant the sources come in a fixed order: order, then stock, then audit.
    await backdate('order_status_history', Number(orderRowId), minutesAfter(5));
    await backdate('audit_log', Number(auditRowId), minutesAfter(5));
    await backdate('stock_adjustments', Number(stockRowId), minutesAfter(5));
    expect((await activity({ type: 'all' })).items.map((item) => item.id)).toEqual([orderEvent, stockEvent, auditEvent]);
  });
});

// --------------------------------------------------------------------------------------------- search and filters
describe('ACT-8: search', () => {
  test('ACT-8 finds events by customer, SKU, product name, administrator and order number, and treats % and _ literally', async () => {
    const sam = await ctx.api.post('/api/customers', { name: 'Searchable Sam', email: 'sam@example.test' });
    expect(sam.status).toBe(201);
    const widget = await ctx.api.post('/api/products', { sku: 'SRCH-1', name: 'Widget Special', price: '4.00', stockQuantity: 10 });
    expect(widget.status).toBe(201);
    const order = await f.createOrderViaApi(ctx.api, { customerId: sam.body.customer.id, items: [{ productId: widget.body.product.id, quantity: 1 }] });
    expect((await adjust(ctx.api, widget.body.product.id, { delta: 1, reason: 'Recount' })).status).toBe(201);
    const other = await f.createAdmin({ email: 'other@example.test', displayName: 'Other Person', passwordHash: ctx.passwordHash });
    const otherApi = client(ctx.app, cookieFor(other));
    expect((await otherApi.post('/api/products', { sku: 'B-ONLY', name: 'Second admin product', price: '2.00' })).status).toBe(201);

    const typesFor = async (q) => sorted(types(await activity({ q })));

    expect(await typesFor('Searchable')).toEqual(['CUSTOMER_CREATED', 'ORDER_CREATED']); // customer name
    expect(await typesFor('searchable')).toEqual(['CUSTOMER_CREATED', 'ORDER_CREATED']); // any letter case
    expect(await typesFor('SRCH-1')).toEqual(['PRODUCT_CREATED', 'STOCK_ADJUSTED']); // SKU
    expect(await typesFor('Widget')).toEqual(['PRODUCT_CREATED', 'STOCK_ADJUSTED']); // product name
    expect(await typesFor('other@example')).toEqual(['PRODUCT_CREATED']); // administrator email
    expect(await typesFor('Other Person')).toEqual(['PRODUCT_CREATED']); // administrator name
    expect(await typesFor(`#${order.id}`)).toEqual(['ORDER_CREATED']); // order number
    expect(await typesFor('no-such-text-anywhere')).toEqual([]);
    // Nothing contains a literal % or _, so these must find nothing (unescaped they would match everything).
    expect(await typesFor('%')).toEqual([]);
    expect(await typesFor('_')).toEqual([]);

    const byOther = await activity({ q: 'other@example' });
    expect(byOther.items[0].actor).toEqual({ id: other.id, email: 'other@example.test', displayName: 'Other Person' });
    expect(byOther.total).toBe(1);
    expect((await activity({})).total).toBe(5); // customer, product, order, stock, second administrator's product
  });
});

describe('ACT-9: the date range', () => {
  test('ACT-9 "from" is inclusive, "to" is exclusive, and bad ranges are refused', async () => {
    const orders = [];
    for (let i = 0; i < 3; i += 1) {
      orders.push(await newOrder([cat.p1, 1]));
      await backdate('order_status_history', (await db.historyIds(orders[i].id))[0], minutesAfter(i));
    }
    const entityIds = (body) => body.items.map((item) => item.entity.id);
    const [t0, t1, t2] = [0, 1, 2].map((i) => minutesAfter(i).toISOString());

    expect(entityIds(await activity({ type: 'order', from: t1 }))).toEqual([orders[2].id, orders[1].id]); // t1 included
    expect(entityIds(await activity({ type: 'order', from: t1, to: t2 }))).toEqual([orders[1].id]); // t2 excluded
    expect(entityIds(await activity({ type: 'order', to: t1 }))).toEqual([orders[0].id]); // t1 excluded
    expect(entityIds(await activity({ type: 'order', from: t0, to: minutesAfter(3).toISOString() }))).toHaveLength(3);
    expect((await activity({ type: 'order', from: '' })).total).toBe(3); // an empty value means "not given"

    for (const query of [`from=${t2}&to=${t1}`, `from=${t1}&to=${t1}`]) {
      const res = await ctx.api.get(`/api/activity?${query}`);
      expect([query, res.status, res.body.fields]).toEqual([query, 400, ['to']]);
    }
    const malformed = await ctx.api.get('/api/activity?from=not-a-date');
    expect(malformed.status).toBe(400);
    expect(malformed.body.fields).toEqual(['from']);
  });
});

describe('ACT-10: paging', () => {
  test('ACT-10 pages are complete, free of duplicates, and in newest-first order across all three sources', async () => {
    const orderId = await f.createOrderSql({ customerId: cat.customer.id });
    for (let i = 0; i < 40; i += 1) {
      await f.insertHistorySql({
        orderId,
        fromStatus: i === 0 ? null : 'PENDING',
        toStatus: i === 0 ? 'PENDING' : 'CONFIRMED',
        adminId: ctx.admin.id,
        changedAt: minutesAfter(i),
      });
    }
    for (let i = 0; i < 12; i += 1) {
      await f.insertMovementSql({ productId: cat.p1.id, quantityDelta: i + 1, reason: `manual ${i}`, adminId: ctx.admin.id, createdAt: minutesAfter(100 + i) });
    }
    for (let i = 0; i < 8; i += 1) {
      expect((await ctx.api.post('/api/products', { sku: `PG-${i}`, name: `Paged ${i}`, price: '1.00' })).status).toBe(201);
    }

    const pages = [];
    for (const page of ['1', '2', '3', '4']) {
      pages.push(await activity({ pageSize: '25', page }));
    }

    expect(pages[0]).toMatchObject({ page: 1, pageSize: 25, total: 60, totalPages: 3 });
    expect(pages.map((body) => body.items.length)).toEqual([25, 25, 10, 0]); // past the end is empty, not an error
    const all = pages.flatMap((body) => body.items);
    expect(new Set(all.map((item) => item.id)).size).toBe(60); // no duplicates, no gaps
    for (let i = 1; i < all.length; i += 1) {
      expect(new Date(all[i - 1].occurredAt).getTime()).toBeGreaterThanOrEqual(new Date(all[i].occurredAt).getTime());
    }
    expect(all.filter((item) => item.id.startsWith('order-'))).toHaveLength(40);
    expect(all.filter((item) => item.id.startsWith('stock-'))).toHaveLength(12);
    expect(all.filter((item) => item.id.startsWith('audit-'))).toHaveLength(8);

    const biggest = await activity({ pageSize: '100' });
    expect(biggest).toMatchObject({ pageSize: 100, total: 60, totalPages: 1 });
  });
});

describe('ACT-11: who did it', () => {
  test('ACT-11 each event names the administrator who made the change', async () => {
    const other = await f.createAdmin({ email: 'second.admin@example.test', displayName: 'Second Admin', passwordHash: ctx.passwordHash });
    const otherApi = client(ctx.app, cookieFor(other));

    expect((await ctx.api.post('/api/customers', { name: 'By First', email: 'first@example.test' })).status).toBe(201);
    expect((await otherApi.post('/api/products', { sku: 'BY-SECOND', name: 'By Second', price: '1.00' })).status).toBe(201);

    const body = await activity({});

    const actors = Object.fromEntries(body.items.map((item) => [item.type, item.actor]));
    expect(actors.CUSTOMER_CREATED).toEqual(actorOf(ctx.admin));
    expect(actors.PRODUCT_CREATED).toEqual({ id: other.id, email: 'second.admin@example.test', displayName: 'Second Admin' });
  });
});

describe('ACT-13: invalid parameters', () => {
  test.each([
    ['type=bogus'],
    ['pageSize=101'],
    ['pageSize=0'],
    ['page=0'],
    ['page=abc'],
    ['from=2026-10-01'], // a date without a time is not accepted
    ['to=tomorrow'],
    ['q=' + 'x'.repeat(101)],
  ])('ACT-13 /api/activity?%s is a 400', async (query) => {
    const res = await ctx.api.get(`/api/activity?${query}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
    expect(Array.isArray(res.body.fields)).toBe(true);
  });
});
