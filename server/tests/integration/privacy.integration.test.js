// Privacy against the real MySQL TEST database (inventory_test): after every kind of change has been made with
// distinctive, made-up personal values, the audit log, the Activity feed and the account/settings/login responses must
// not contain passwords, hashes, tokens or the personal field values.
// This file WRITES to the test database: every test starts from empty tables (resetTestDatabase) and the tables are
// emptied again afterwards. See tests/helpers/integrationEnv.js for the guards that refuse to run against anything but
// inventory_test.
//
// The markers below are random per run and exist only in this process: no real personal data or credentials are used.
const crypto = require('crypto');
const { INTEGRATION_TIMEOUT, useIntegrationDatabase } = require('../helpers/integrationEnv');
const f = require('../helpers/factories');
const db = require('../helpers/dbAssert');
const { client, cookieFromResponse, loginCookie } = require('../helpers/http');
const { assertNoSecrets } = require('../helpers/privacy');

jest.setTimeout(INTEGRATION_TIMEOUT);

const ctx = useIntegrationDatabase();

// What an audit event of each type may contain (the property names of its details). null means "no details at all".
const ALLOWED_DETAIL_KEYS = {
  PRODUCT_CREATED: ['price'],
  PRODUCT_UPDATED: ['changedFields', 'changes'],
  PRODUCT_ACTIVATED: null,
  PRODUCT_DEACTIVATED: null,
  CUSTOMER_CREATED: null,
  CUSTOMER_UPDATED: ['changedFields'],
  CUSTOMER_ACTIVATED: null,
  CUSTOMER_DEACTIVATED: null,
  ACCOUNT_PROFILE_UPDATED: ['changedFields'],
  ACCOUNT_PASSWORD_CHANGED: null,
  SETTINGS_UPDATED: ['key', 'from', 'to'],
};

describe('PRIV-1 to PRIV-3: after every kind of change', () => {
  let m; // the made-up markers
  let fresh; // an api signed in with the cookie issued by the password change (the old cookie ended with it)

  beforeEach(async () => {
    const tag = crypto.randomBytes(4).toString('hex');
    m = {
      customerName: `PrivName${tag}`,
      customerName2: `PrivRenamed${tag}`,
      customerEmail: `priv-first-${tag}@customers.test`,
      customerEmail2: `priv-second-${tag}@customers.test`,
      phone: '555-0188',
      phone2: '555-0199',
      address: `1 Marker Lane ${tag}`,
      address2: `2 Marker Lane ${tag}`,
      sku: `PRIVSKU-${tag}`,
      sku2: `PRIVSKU2-${tag}`,
      productName: `PrivProduct${tag}`,
      productName2: `PrivProductRenamed${tag}`,
      reason: `PrivReason${tag}`,
      displayName: `PrivDisplay${tag}`,
      adminEmail2: `priv-admin-${tag}@staff.test`,
      newPassword: crypto.randomBytes(12).toString('hex'),
    };
    m.originalAdminEmail = ctx.admin.email;

    const api = ctx.api;
    const ok = async (promise, status = 200) => {
      const res = await promise;
      if (res.status !== status) throw new Error(`Scenario step failed: HTTP ${res.status}`);
      return res;
    };

    const customer = (await ok(api.post('/api/customers', { name: m.customerName, email: m.customerEmail, phone: m.phone, address: m.address }), 201)).body.customer;
    await ok(api.patch(`/api/customers/${customer.id}`, { name: m.customerName2, email: m.customerEmail2, phone: m.phone2, address: m.address2 }));
    await ok(api.post(`/api/customers/${customer.id}/deactivate`));
    await ok(api.post(`/api/customers/${customer.id}/reactivate`));

    const product = (await ok(api.post('/api/products', { sku: m.sku, name: m.productName, price: '7.00', stockQuantity: 5 }), 201)).body.product;
    await ok(api.patch(`/api/products/${product.id}`, { sku: m.sku2, name: m.productName2, price: '8.00' }));
    await ok(api.post(`/api/products/${product.id}/deactivate`));
    await ok(api.post(`/api/products/${product.id}/reactivate`));
    await ok(api.post(`/api/products/${product.id}/stock-adjustments`, { delta: 2, reason: m.reason }), 201);

    const order = (await ok(api.post('/api/orders', { customerId: customer.id, items: [{ productId: product.id, quantity: 1 }] }), 201)).body.order;
    await ok(api.post(`/api/orders/${order.id}/confirm`));
    await ok(api.post(`/api/orders/${order.id}/cancel`));

    await ok(api.patch('/api/settings', { lowStockThreshold: 9 }));
    await ok(api.patch('/api/account/profile', { displayName: m.displayName }));
    await ok(api.patch('/api/account/profile', { email: m.adminEmail2, currentPassword: ctx.password }));
    const changed = await ok(api.post('/api/account/password', { currentPassword: ctx.password, newPassword: m.newPassword }));
    fresh = client(ctx.app, cookieFromResponse(changed));
  });

  test('PRIV-1 the stored audit details contain none of the personal values, passwords, hashes or tokens', async () => {
    const rows = await db.auditRows();

    // 4 customer + 4 product + 1 settings + 3 account events: the scenario really was audited.
    expect(rows).toHaveLength(12);
    const stored = JSON.stringify(rows.map((row) => row.details));
    const markers = Object.values(m); // every personal value, old and new, plus the passwords and the stock reason
    for (const marker of [...markers, ctx.password]) {
      expect(stored.includes(marker)).toBe(false);
    }
    assertNoSecrets(rows.map((row) => row.details), [...markers, ctx.password]);
  });

  test('PRIV-2 the Activity feed shows no contact details, old values, passwords, hashes or tokens', async () => {
    const res = await fresh.get('/api/activity?pageSize=100');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(16); // 3 order + 1 stock + 12 audit events
    const admin = await db.adminRow(ctx.admin.id);
    // Current names and the stock reason are shown on purpose. Contact details, previous values and secrets never are.
    const forbidden = [
      m.customerEmail, m.customerEmail2, m.phone, m.phone2, m.address, m.address2, // customer contact details
      m.customerName, m.sku, m.productName, // values from BEFORE the renames
      m.originalAdminEmail, // the administrator's previous email
      ctx.password, m.newPassword, admin.passwordHash,
    ];
    assertNoSecrets(res.body, forbidden);
    // What is shown is current: the renamed customer and product and the administrator's present email.
    const text = JSON.stringify(res.body);
    expect(text).toContain(m.customerName2);
    expect(text).toContain(m.productName2);
    expect(text).toContain(m.adminEmail2);
  });

  test('PRIV-3 every stored audit event holds only the properties its type allows', async () => {
    const rows = await db.auditRows();

    for (const row of rows) {
      const allowed = ALLOWED_DETAIL_KEYS[row.eventType];
      expect([row.eventType, allowed !== undefined]).toEqual([row.eventType, true]); // no unknown event type
      if (allowed === null) {
        expect([row.eventType, row.details]).toEqual([row.eventType, null]);
      } else {
        expect(row.details).not.toBeNull();
        expect(Object.keys(row.details).filter((key) => !allowed.includes(key))).toEqual([]);
      }
    }
    // Only the price of a product price change carries values; the old and new text of sku and name are not stored.
    const update = rows.find((row) => row.eventType === 'PRODUCT_UPDATED');
    expect(update.details).toEqual({ changedFields: ['sku', 'name', 'price'], changes: { price: { from: '7.00', to: '8.00' } } });
  });
});

describe('PRIV-4: responses never carry secrets or internals', () => {
  const INTERNALS = /node_modules|\bat \S+ \(|ER_[A-Z_]+|sqlMessage|SELECT |INSERT |UPDATE |password_hash|token_version/;

  test('PRIV-4 account, session, settings and error responses contain no hash, token, version or stack trace', async () => {
    const hash = (await db.adminRow(ctx.admin.id)).passwordHash;
    const login = await client(ctx.app, null).post('/api/auth/login', { email: ctx.admin.email, password: ctx.password });
    const responses = {
      account: await ctx.api.get('/api/account'),
      me: await ctx.api.get('/api/auth/me'),
      login,
      settings: await ctx.api.get('/api/settings'),
      notSignedIn: await client(ctx.app, null).get('/api/account'),
      missingOrder: await ctx.api.get('/api/orders/999999999'),
      invalidId: await ctx.api.get('/api/orders/abc'),
      invalidBody: await ctx.api.post('/api/orders', { customerId: 'x' }),
      wrongPassword: await ctx.api.post('/api/account/password', { currentPassword: 'definitely-the-wrong-password', newPassword: 'another-long-password-123' }),
      duplicate: await (async () => {
        await f.createCustomer({ email: 'dup@example.test' });
        return ctx.api.post('/api/customers', { name: 'Dup', email: 'dup@example.test' });
      })(),
    };
    expect(responses.login.status).toBe(200);
    expect(responses.duplicate.status).toBe(409);

    for (const [name, res] of Object.entries(responses)) {
      assertNoSecrets(res.body, [hash, ctx.password]);
      expect([name, INTERNALS.test(JSON.stringify(res.body))]).toEqual([name, false]);
    }
    expect(Object.keys(responses.account.body.account).sort()).toEqual(['createdAt', 'displayName', 'email', 'id']);
    expect(Object.keys(responses.me.body.admin).sort()).toEqual(['email', 'id']);
    expect(Object.keys(responses.login.body.admin).sort()).toEqual(['email', 'id']);
  });

  test('PRIV-4 the session cookie value is the only place a token appears, and it is HttpOnly', async () => {
    const res = await client(ctx.app, null).post('/api/auth/login', { email: ctx.admin.email, password: ctx.password });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/eyJ/); // no token in the body
    expect(await loginCookie(ctx.app, ctx.admin.email, ctx.password)).toMatch(/^admin_token=eyJ/);
    expect(res.headers['set-cookie'].join(';')).toMatch(/HttpOnly/i);
  });
});
