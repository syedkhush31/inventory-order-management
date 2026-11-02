// Test data builders for the integration tests.
//
// Two ways of creating data, on purpose:
//   - Direct SQL (createAdmin, createCustomer, createProduct, createOrderSql): fast and able to build states the API
//     refuses, such as an inactive customer or an enormous stock. These rows bypass the audit log by design.
//   - The real API (createOrderViaApi, orderInStatus, doAction): used wherever the behaviour under test must be the
//     genuine one, for example stock deductions and status history.
// All SQL goes through integrationEnv.query(), which only ever talks to the verified inventory_test database.
const { query } = require('./integrationEnv');

let counter = 0;
const next = () => {
  counter += 1;
  return counter;
};

async function createAdmin({ email, passwordHash, displayName = null } = {}) {
  if (!passwordHash) {
    throw new Error('createAdmin needs a passwordHash (use ctx.passwordHash).');
  }
  const address = email || `admin${next()}@example.test`;
  const result = await query('INSERT INTO admins (email, display_name, password_hash) VALUES (?, ?, ?)', [
    address,
    displayName,
    passwordHash,
  ]);
  return { id: Number(result.insertId), email: address };
}

async function createCustomer({ name, email, phone = null, address = null, isActive = true } = {}) {
  const n = next();
  const row = {
    name: name || `Customer ${n}`,
    email: email || `customer${n}@example.test`,
  };
  const result = await query(
    'INSERT INTO customers (name, email, phone, address, is_active) VALUES (?, ?, ?, ?, ?)',
    [row.name, row.email, phone, address, isActive ? 1 : 0]
  );
  return { id: Number(result.insertId), name: row.name, email: row.email, isActive };
}

// price is text such as "10.00"; stock is the starting stock_quantity.
async function createProduct({ sku, name, price = '10.00', stock = 0, isActive = true } = {}) {
  const n = next();
  const row = { sku: sku || `SKU-${n}`, name: name || `Product ${n}` };
  const result = await query(
    'INSERT INTO products (sku, name, price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?)',
    [row.sku, row.name, price, stock, isActive ? 1 : 0]
  );
  return { id: Number(result.insertId), sku: row.sku, name: row.name, price, stock, isActive };
}

// Sets a product's stock directly (for example to just below the column maximum).
async function setStock(productId, stock) {
  await query('UPDATE products SET stock_quantity = ? WHERE id = ?', [stock, productId]);
}

// The usual starting point of the order and stock tests.
//   customer / inactiveCustomer   one active, one inactive
//   p1  price 10.00, stock 10     p2  price 2.50, stock 5     p3  price 1.00, stock 5, INACTIVE
async function createCatalogue() {
  const customer = await createCustomer({ name: 'Ann Example', email: 'ann@example.test' });
  const inactiveCustomer = await createCustomer({
    name: 'Inactive Customer',
    email: 'inactive@example.test',
    isActive: false,
  });
  const p1 = await createProduct({ sku: 'P-ONE', name: 'Product One', price: '10.00', stock: 10 });
  const p2 = await createProduct({ sku: 'P-TWO', name: 'Product Two', price: '2.50', stock: 5 });
  const p3 = await createProduct({ sku: 'P-OFF', name: 'Inactive Product', price: '1.00', stock: 5, isActive: false });
  return { customer, inactiveCustomer, p1, p2, p3 };
}

// Turns [[product, quantity], ...] into the request body's items list.
const lines = (...pairs) => pairs.map(([product, quantity]) => ({ productId: product.id, quantity }));

// Creates a PENDING order through POST /api/orders. Throws (with the status and message only) unless it answers 201.
async function createOrderViaApi(api, { customerId, items }) {
  const res = await api.post('/api/orders', { customerId, items });
  if (res.status !== 201 || !res.body || !res.body.order) {
    throw new Error(`Could not create the test order: HTTP ${res.status} ${res.body && res.body.error}`);
  }
  return res.body.order;
}

// POST /api/orders/:id/<action> (confirm, cancel, ship, deliver). Returns the raw response without judging it.
function doAction(api, orderId, action) {
  return api.post(`/api/orders/${orderId}/${action}`);
}

const PATH_TO_STATUS = {
  PENDING: [],
  CONFIRMED: ['confirm'],
  SHIPPED: ['confirm', 'ship'],
  DELIVERED: ['confirm', 'ship', 'deliver'],
  CANCELLED: ['cancel'],
};

// Creates an order and walks it to `status` through the real API, so stock, movements and history are genuine.
// Returns the order as the last response described it.
async function orderInStatus(api, status, { customerId, items }) {
  const steps = PATH_TO_STATUS[status];
  if (!steps) {
    throw new Error(`Unknown order status: ${status}`);
  }
  let order = await createOrderViaApi(api, { customerId, items });
  for (const action of steps) {
    const res = await doAction(api, order.id, action);
    if (res.status !== 200 || !res.body || !res.body.order) {
      throw new Error(`Could not ${action} test order ${order.id}: HTTP ${res.status} ${res.body && res.body.error}`);
    }
    order = res.body.order;
  }
  return order;
}

// Inserts an order row directly (no lines, no history): for list, search, sort and paging tests that need many orders
// quickly. createdAt (a Date) sets both created_at and updated_at; omit it for "now". Returns the new order id.
async function createOrderSql({ customerId, status = 'PENDING', totalAmount = '1.00', createdAt = new Date() }) {
  const result = await query(
    'INSERT INTO orders (customer_id, status, total_amount, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [customerId, status, totalAmount, createdAt, createdAt]
  );
  return Number(result.insertId);
}

// Inserts an order_status_history row directly (an order event for the Activity page), at a chosen time.
async function insertHistorySql({ orderId, fromStatus, toStatus, adminId, changedAt = new Date() }) {
  const result = await query(
    `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by_admin_id, changed_at)
     VALUES (?, ?, ?, ?, ?)`,
    [orderId, fromStatus, toStatus, adminId, changedAt]
  );
  return Number(result.insertId);
}

// Inserts a MANUAL stock_adjustments row directly (a manual correction event), at a chosen time.
async function insertMovementSql({ productId, quantityDelta, reason, adminId, createdAt = new Date() }) {
  const result = await query(
    'INSERT INTO stock_adjustments (product_id, quantity_delta, reason, admin_id, created_at) VALUES (?, ?, ?, ?, ?)',
    [productId, quantityDelta, reason, adminId, createdAt]
  );
  return Number(result.insertId);
}

module.exports = {
  insertHistorySql,
  insertMovementSql,
  createAdmin,
  createCustomer,
  createProduct,
  setStock,
  createCatalogue,
  lines,
  createOrderViaApi,
  doAction,
  orderInStatus,
  createOrderSql,
};
