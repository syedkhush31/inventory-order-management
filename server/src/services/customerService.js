// Turns database rows into the shape the API returns.
const customerRepository = require('../repositories/customerRepository');
const auditService = require('./auditService');
const { withTransaction } = require('../config/db');

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

const CUSTOMER_FIELDS = ['name', 'email', 'phone', 'address'];

// Which of the fields an edit sends really differ from the stored customer (null and "not sent" are different:
// null clears phone or address). Returns the field NAMES only: the audit log never holds a customer's details.
function changedCustomerFields(before, data) {
  return CUSTOMER_FIELDS.filter((field) => data[field] !== undefined && (data[field] ?? null) !== (before[field] ?? null));
}

// Saves the customer and its audit record in ONE transaction, then reads it back so the response contains the values
// MySQL generated. adminId is the signed-in administrator.
async function createCustomer(data, adminId) {
  let id;
  try {
    id = await withTransaction(async (connection) => {
      const newId = await customerRepository.create(data, connection);
      await auditService.record(connection, { adminId, eventType: 'CUSTOMER_CREATED', entityId: newId });
      return newId;
    });
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

// Changes the given fields and, if something really changed, records which fields in the audit log in the same
// transaction. The row is locked first so the comparison uses the real stored values. Then the customer is read back.
async function updateCustomer(id, data, adminId) {
  try {
    await withTransaction(async (connection) => {
      const before = await customerRepository.findByIdForUpdate(connection, id);
      if (!before) {
        throw new CustomerNotFoundError();
      }
      await customerRepository.update(id, data, connection);
      const changedFields = changedCustomerFields(before, data);
      if (changedFields.length > 0) {
        await auditService.record(connection, {
          adminId,
          eventType: 'CUSTOMER_UPDATED',
          entityId: id,
          details: { changedFields },
        });
      }
    });
  } catch (err) {
    if (isDuplicateEmail(err)) {
      throw new DuplicateEmailError();
    }
    throw err;
  }
  return getExistingCustomer(id);
}

// Deactivating hides a customer from the default list; nothing is deleted, so order history stays intact.
// Repeating a request that changes nothing is harmless and is not recorded in the audit log.
async function setCustomerActive(id, isActive, adminId) {
  await withTransaction(async (connection) => {
    const before = await customerRepository.findByIdForUpdate(connection, id);
    if (!before) {
      throw new CustomerNotFoundError();
    }
    if (Boolean(before.is_active) !== isActive) {
      await customerRepository.setActive(id, isActive, connection);
      await auditService.record(connection, {
        adminId,
        eventType: isActive ? 'CUSTOMER_ACTIVATED' : 'CUSTOMER_DEACTIVATED',
        entityId: id,
      });
    }
  });
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
