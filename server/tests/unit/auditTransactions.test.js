// Product and customer changes are saved together with their audit record, or not at all.
// The repositories and the transaction helper are fakes: the fake transaction records begin / commit / rollback and
// really "undoes" what a callback did when it fails, so we can prove the audit record and the change share fate.
// These tests do NOT prove how MySQL behaves; they prove our code uses ONE transaction connection for both writes.
jest.mock('../../src/config/db', () => ({ withTransaction: jest.fn(), getPool: jest.fn() }));
jest.mock('../../src/repositories/auditRepository', () => ({ insert: jest.fn() }));
jest.mock('../../src/repositories/productRepository', () => ({
  create: jest.fn(),
  findById: jest.fn(),
  findByIdForUpdate: jest.fn(),
  update: jest.fn(),
  setActive: jest.fn(),
}));
jest.mock('../../src/repositories/customerRepository', () => ({
  create: jest.fn(),
  findById: jest.fn(),
  findByIdForUpdate: jest.fn(),
  update: jest.fn(),
  setActive: jest.fn(),
}));

const db = require('../../src/config/db');
const auditRepository = require('../../src/repositories/auditRepository');
const productRepository = require('../../src/repositories/productRepository');
const customerRepository = require('../../src/repositories/customerRepository');
const productService = require('../../src/services/productService');
const customerService = require('../../src/services/customerService');

const ADMIN = 7;
const PRODUCT_ROW = { id: 5, sku: 'SKU-1', name: 'USB Hub', price: '24.50', stock_quantity: 3, is_active: 1, created_at: new Date(), updated_at: new Date() };
const CUSTOMER_ROW = { id: 9, name: 'Ann Lee', email: 'ann@example.com', phone: '555 0100', address: '1 Main St', is_active: 1, created_at: new Date(), updated_at: new Date() };

let connection;
let events; // everything that happened, in order: 'begin', 'write:<what>', 'commit' | 'rollback'
let committed; // writes that survived

beforeEach(() => {
  jest.resetAllMocks();
  events = [];
  committed = [];
  connection = { name: 'the-one-transaction-connection', query: jest.fn() };
  const record = (what) => (...args) => {
    // every write must receive the transaction connection
    const used = args.includes(connection);
    events.push(`write:${what}${used ? '' : ':WITHOUT-CONNECTION'}`);
  };
  db.withTransaction.mockImplementation(async (fn) => {
    events.push('begin');
    const before = events.length;
    try {
      const result = await fn(connection);
      events.push('commit');
      committed.push(...events.slice(before).filter((e) => e.startsWith('write:')));
      return result;
    } catch (err) {
      events.push('rollback');
      throw err;
    }
  });
  productRepository.create.mockImplementation(async (data, c) => { record('product-create')(data, c); return 5; });
  productRepository.update.mockImplementation(async (id, data, c) => record('product-update')(id, data, c));
  productRepository.setActive.mockImplementation(async (id, flag, c) => record('product-setActive')(id, flag, c));
  productRepository.findByIdForUpdate.mockResolvedValue(PRODUCT_ROW);
  productRepository.findById.mockResolvedValue(PRODUCT_ROW);
  customerRepository.create.mockImplementation(async (data, c) => { record('customer-create')(data, c); return 9; });
  customerRepository.update.mockImplementation(async (id, data, c) => record('customer-update')(id, data, c));
  customerRepository.setActive.mockImplementation(async (id, flag, c) => record('customer-setActive')(id, flag, c));
  customerRepository.findByIdForUpdate.mockResolvedValue(CUSTOMER_ROW);
  customerRepository.findById.mockResolvedValue(CUSTOMER_ROW);
  auditRepository.insert.mockImplementation(async (c, event) => {
    events.push(`write:audit:${event.eventType}${c === connection ? '' : ':WITHOUT-CONNECTION'}`);
    return 1;
  });
});

describe('products: the change and its audit record share one transaction', () => {
  test('create: both writes use the same connection and are committed together', async () => {
    await productService.createProduct({ sku: 'SKU-1', name: 'USB Hub', price: '24.5', stockQuantity: 3 }, ADMIN);
    expect(events).toEqual(['begin', 'write:product-create', 'write:audit:PRODUCT_CREATED', 'commit']);
    expect(auditRepository.insert.mock.calls[0][1]).toMatchObject({ adminId: ADMIN, entityId: 5, details: { price: '24.50' } });
    expect(JSON.stringify(auditRepository.insert.mock.calls[0][1])).not.toMatch(/SKU-1|USB Hub/);
  });

  test('create: if the audit write fails the product write is rolled back and the error is raised', async () => {
    auditRepository.insert.mockRejectedValue(new Error('audit down'));
    await expect(productService.createProduct({ sku: 'SKU-1', name: 'n', price: '1', stockQuantity: 0 }, ADMIN)).rejects.toThrow('audit down');
    expect(events).toEqual(['begin', 'write:product-create', 'rollback']);
    expect(committed).toEqual([]);
  });

  test('create: a duplicate SKU rolls back, becomes DuplicateSkuError and writes no audit record', async () => {
    productRepository.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY', sqlMessage: "Duplicate entry 'x' for key 'products.uq_products_sku'" }));
    await expect(productService.createProduct({ sku: 'SKU-1', name: 'n', price: '1', stockQuantity: 0 }, ADMIN)).rejects.toBeInstanceOf(productService.DuplicateSkuError);
    expect(auditRepository.insert).not.toHaveBeenCalled();
    expect(events).toEqual(['begin', 'rollback']);
  });

  test('update: the row is locked and read on the connection first, then written and audited, then committed', async () => {
    await productService.updateProduct(5, { price: '30.00', sku: 'SKU-2' }, ADMIN);
    expect(productRepository.findByIdForUpdate).toHaveBeenCalledWith(connection, 5);
    expect(events).toEqual(['begin', 'write:product-update', 'write:audit:PRODUCT_UPDATED', 'commit']);
    // The SKU changed, so it is named, but neither SKU value is stored. Only the price carries old and new values.
    expect(auditRepository.insert.mock.calls[0][1].details).toEqual({
      changedFields: ['sku', 'price'],
      changes: { price: { from: '24.50', to: '30.00' } },
    });
    expect(JSON.stringify(auditRepository.insert.mock.calls[0][1])).not.toMatch(/SKU-1|SKU-2/);
  });

  test('update: if the audit write fails the update is rolled back', async () => {
    auditRepository.insert.mockRejectedValue(new Error('audit down'));
    await expect(productService.updateProduct(5, { name: 'New' }, ADMIN)).rejects.toThrow('audit down');
    expect(events).toEqual(['begin', 'write:product-update', 'rollback']);
    expect(committed).toEqual([]);
  });

  test('update: if the product update fails nothing is audited', async () => {
    productRepository.update.mockRejectedValue(new Error('update failed'));
    await expect(productService.updateProduct(5, { name: 'New' }, ADMIN)).rejects.toThrow('update failed');
    expect(auditRepository.insert).not.toHaveBeenCalled();
    expect(events).toEqual(['begin', 'rollback']);
  });

  test('update: nothing really changed means no audit record (name and price written differently)', async () => {
    await productService.updateProduct(5, { name: 'USB Hub', price: '24.5' }, ADMIN);
    expect(auditRepository.insert).not.toHaveBeenCalled();
    expect(events).toEqual(['begin', 'write:product-update', 'commit']);
  });

  test('update: only the changed fields are listed', async () => {
    await productService.updateProduct(5, { name: 'USB Hub', price: '25.00' }, ADMIN);
    expect(auditRepository.insert.mock.calls[0][1].details).toEqual({ changedFields: ['price'], changes: { price: { from: '24.50', to: '25.00' } } });
  });

  test('update and activation of a missing product: 404 error, no write, no audit, rolled back', async () => {
    productRepository.findByIdForUpdate.mockResolvedValue(null);
    await expect(productService.updateProduct(99, { name: 'x' }, ADMIN)).rejects.toBeInstanceOf(productService.ProductNotFoundError);
    await expect(productService.setProductActive(99, false, ADMIN)).rejects.toBeInstanceOf(productService.ProductNotFoundError);
    expect(productRepository.update).not.toHaveBeenCalled();
    expect(productRepository.setActive).not.toHaveBeenCalled();
    expect(auditRepository.insert).not.toHaveBeenCalled();
  });

  test('deactivate then reactivate: each real change is audited once, repeats are not', async () => {
    await productService.setProductActive(5, false, ADMIN); // active -> inactive
    expect(events).toEqual(['begin', 'write:product-setActive', 'write:audit:PRODUCT_DEACTIVATED', 'commit']);
    events.length = 0;
    await productService.setProductActive(5, true, ADMIN); // already active: no change
    expect(events).toEqual(['begin', 'commit']);
    productRepository.findByIdForUpdate.mockResolvedValue({ ...PRODUCT_ROW, is_active: 0 });
    events.length = 0;
    await productService.setProductActive(5, true, ADMIN); // inactive -> active
    expect(events).toEqual(['begin', 'write:product-setActive', 'write:audit:PRODUCT_ACTIVATED', 'commit']);
  });

  test('activation: if the audit write fails the flag change is rolled back', async () => {
    auditRepository.insert.mockRejectedValue(new Error('audit down'));
    await expect(productService.setProductActive(5, false, ADMIN)).rejects.toThrow('audit down');
    expect(events).toEqual(['begin', 'write:product-setActive', 'rollback']);
  });
});

describe('what the services put in the audit log', () => {
  test('a product name or SKU change is recorded as a field name only, whatever the text says', async () => {
    const nasty = 'john.smith@example.com +44 20 7946 0958 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln 1 Main St';
    await productService.updateProduct(5, { name: nasty, sku: 'SKU-X' }, ADMIN);
    const event = auditRepository.insert.mock.calls[0][1];
    expect(event.details).toEqual({ changedFields: ['sku', 'name'] });
    expect(JSON.stringify(event)).not.toMatch(/john|@|7946|eyJ|Main St|SKU-X/);
  });

  test('creating a product with contact details in its name stores only the price', async () => {
    await productService.createProduct({ sku: 'SKU-9', name: 'Support: help@example.com 555 0100', price: '9.99', stockQuantity: 0 }, ADMIN);
    const event = auditRepository.insert.mock.calls[0][1];
    expect(event.details).toEqual({ price: '9.99' });
    expect(JSON.stringify(event)).not.toMatch(/help@|555|SKU-9|Support/);
  });

  test('extra properties on the data a service receives never reach the audit record (the request body is not logged)', async () => {
    const extras = { email: 'ann@example.com', password: 'secret-password-1', token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln', phone: '555 0100', address: '1 Main St' };
    await productService.createProduct({ sku: 'S', name: 'n', price: '1', stockQuantity: 0, ...extras }, ADMIN);
    await productService.updateProduct(5, { price: '30.00', ...extras }, ADMIN);
    await customerService.createCustomer({ name: 'A', email: 'a@b.co', phone: null, address: null, ...extras }, ADMIN);
    await customerService.updateCustomer(9, { name: 'Other', ...extras }, ADMIN);
    expect(auditRepository.insert).toHaveBeenCalledTimes(4);
    for (const [, event] of auditRepository.insert.mock.calls) {
      expect(JSON.stringify(event)).not.toMatch(/ann@example|secret-password|eyJ|555|Main St/);
    }
    expect(auditRepository.insert.mock.calls.map(([, e]) => e.details)).toEqual([
      { price: '1.00' },
      { changedFields: ['price'], changes: { price: { from: '24.50', to: '30.00' } } },
      null,
      { changedFields: ['name'] },
    ]);
  });

  test('a stored product with an empty name or SKU can still be edited (nothing free-text is compared into the log)', async () => {
    productRepository.findByIdForUpdate.mockResolvedValue({ ...PRODUCT_ROW, name: '', sku: '' });
    await productService.updateProduct(5, { name: 'Now named', sku: 'SKU-NEW' }, ADMIN);
    expect(auditRepository.insert.mock.calls[0][1].details).toEqual({ changedFields: ['sku', 'name'] });
    expect(events).toEqual(['begin', 'write:product-update', 'write:audit:PRODUCT_UPDATED', 'commit']);
  });
});

describe('customers: the change and its audit record share one transaction', () => {
  test('create: one connection, committed together, and no customer details in the audit record', async () => {
    await customerService.createCustomer({ name: 'Ann Lee', email: 'ann@example.com', phone: '555 0100', address: '1 Main St' }, ADMIN);
    expect(events).toEqual(['begin', 'write:customer-create', 'write:audit:CUSTOMER_CREATED', 'commit']);
    const event = auditRepository.insert.mock.calls[0][1];
    expect(event).toMatchObject({ adminId: ADMIN, entityId: 9, details: null });
    expect(JSON.stringify(event)).not.toMatch(/Ann|@|555|Main/);
  });

  test('create: if the audit write fails the customer is rolled back', async () => {
    auditRepository.insert.mockRejectedValue(new Error('audit down'));
    await expect(customerService.createCustomer({ name: 'A', email: 'a@b.co', phone: null, address: null }, ADMIN)).rejects.toThrow('audit down');
    expect(events).toEqual(['begin', 'write:customer-create', 'rollback']);
  });

  test('create: a duplicate email rolls back, becomes DuplicateEmailError and writes no audit record', async () => {
    customerRepository.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY', sqlMessage: "Duplicate entry 'x' for key 'customers.uq_customers_email'" }));
    await expect(customerService.createCustomer({ name: 'A', email: 'a@b.co', phone: null, address: null }, ADMIN)).rejects.toBeInstanceOf(customerService.DuplicateEmailError);
    expect(auditRepository.insert).not.toHaveBeenCalled();
  });

  test('update: audits field NAMES only, in a fixed order, never old or new values', async () => {
    await customerService.updateCustomer(9, { email: 'new@example.com', name: 'Ann Smith', phone: null }, ADMIN);
    expect(events).toEqual(['begin', 'write:customer-update', 'write:audit:CUSTOMER_UPDATED', 'commit']);
    const event = auditRepository.insert.mock.calls[0][1];
    expect(event.details).toEqual({ changedFields: ['name', 'email', 'phone'] });
    expect(JSON.stringify(event)).not.toMatch(/Ann|new@example|555/);
  });

  test('update: clearing an already empty phone, or re-sending the same values, is not a change', async () => {
    customerRepository.findByIdForUpdate.mockResolvedValue({ ...CUSTOMER_ROW, phone: null });
    await customerService.updateCustomer(9, { phone: null, name: 'Ann Lee', address: '1 Main St' }, ADMIN);
    expect(auditRepository.insert).not.toHaveBeenCalled();
  });

  test('update: if the audit write fails the update is rolled back', async () => {
    auditRepository.insert.mockRejectedValue(new Error('audit down'));
    await expect(customerService.updateCustomer(9, { name: 'New' }, ADMIN)).rejects.toThrow('audit down');
    expect(events).toEqual(['begin', 'write:customer-update', 'rollback']);
  });

  test('update and activation of a missing customer: 404 error, no write, no audit', async () => {
    customerRepository.findByIdForUpdate.mockResolvedValue(null);
    await expect(customerService.updateCustomer(99, { name: 'x' }, ADMIN)).rejects.toBeInstanceOf(customerService.CustomerNotFoundError);
    await expect(customerService.setCustomerActive(99, false, ADMIN)).rejects.toBeInstanceOf(customerService.CustomerNotFoundError);
    expect(customerRepository.update).not.toHaveBeenCalled();
    expect(customerRepository.setActive).not.toHaveBeenCalled();
    expect(auditRepository.insert).not.toHaveBeenCalled();
  });

  test('deactivate and reactivate: each real change is audited once, repeats are not', async () => {
    await customerService.setCustomerActive(9, false, ADMIN);
    expect(events).toEqual(['begin', 'write:customer-setActive', 'write:audit:CUSTOMER_DEACTIVATED', 'commit']);
    events.length = 0;
    await customerService.setCustomerActive(9, true, ADMIN); // already active
    expect(events).toEqual(['begin', 'commit']);
    customerRepository.findByIdForUpdate.mockResolvedValue({ ...CUSTOMER_ROW, is_active: 0 });
    events.length = 0;
    await customerService.setCustomerActive(9, true, ADMIN);
    expect(events).toEqual(['begin', 'write:customer-setActive', 'write:audit:CUSTOMER_ACTIVATED', 'commit']);
  });
});

test('every write in these flows received the transaction connection (none ran on the pool)', async () => {
  await productService.createProduct({ sku: 'S', name: 'n', price: '1', stockQuantity: 0 }, ADMIN);
  await productService.updateProduct(5, { name: 'Other' }, ADMIN);
  await productService.setProductActive(5, false, ADMIN);
  await customerService.createCustomer({ name: 'A', email: 'a@b.co', phone: null, address: null }, ADMIN);
  await customerService.updateCustomer(9, { name: 'Other' }, ADMIN);
  await customerService.setCustomerActive(9, false, ADMIN);
  expect(events.filter((e) => e.includes('WITHOUT-CONNECTION'))).toEqual([]);
  expect(events.filter((e) => e.startsWith('write:'))).toHaveLength(12);
});
