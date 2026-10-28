// Turns database rows into the shape the API returns.
const customerRepository = require('../repositories/customerRepository');

function toCustomer(row) {
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listCustomers(query) {
  const { rows, total } = await customerRepository.list(query);
  return {
    items: rows.map(toCustomer),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

class DuplicateEmailError extends Error {
  constructor() {
    super('A customer with this email already exists');
    this.name = 'DuplicateEmailError';
  }
}

class CustomerNotFoundError extends Error {
  constructor() {
    super('Customer not found');
    this.name = 'CustomerNotFoundError';
  }
}

// True only for a duplicate on the email unique key (not for any other kind of database error).
function isDuplicateEmail(err) {
  return err && err.code === 'ER_DUP_ENTRY' && String(err.sqlMessage || '').includes('uq_customers_email');
}

async function getExistingCustomer(id) {
  const row = await customerRepository.findById(id);
  if (!row) {
    throw new CustomerNotFoundError();
  }
  return toCustomer(row);
}

// Saves the customer, then reads it back so the response contains the values MySQL generated.
async function createCustomer(data) {
  let id;
  try {
    id = await customerRepository.create(data);
  } catch (err) {
    if (isDuplicateEmail(err)) {
      throw new DuplicateEmailError();
    }
    throw err;
  }

  const row = await customerRepository.findById(id);
  if (!row) {
    throw new Error('Created customer could not be read back');
  }
  return toCustomer(row);
}

// Changes the given fields, then reads the customer back.
async function updateCustomer(id, data) {
  try {
    await customerRepository.update(id, data);
  } catch (err) {
    if (isDuplicateEmail(err)) {
      throw new DuplicateEmailError();
    }
    throw err;
  }
  return getExistingCustomer(id);
}

// Deactivating hides a customer from the default list; nothing is deleted, so order history stays intact.
async function setCustomerActive(id, isActive) {
  await customerRepository.setActive(id, isActive);
  return getExistingCustomer(id);
}

module.exports = {
  listCustomers,
  createCustomer,
  updateCustomer,
  setCustomerActive,
  DuplicateEmailError,
  CustomerNotFoundError,
};
