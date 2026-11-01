// Turns database rows into the shape the API returns.
const productRepository = require('../repositories/productRepository');
const stockAdjustmentRepository = require('../repositories/stockAdjustmentRepository');
const auditService = require('./auditService');
const { withTransaction } = require('../config/db');
const { toCents, formatCents } = require('../utils/money');
const { MAX_STOCK_QUANTITY } = require('../validation/productSchemas');

// price stays a string (e.g. "19.99") so money is never converted to a floating-point number.
function toProduct(row) {
  return {
    id: Number(row.id),
    sku: row.sku,
    name: row.name,
    price: String(row.price),
    stockQuantity: Number(row.stock_quantity),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listProducts(query) {
  const { rows, total } = await productRepository.list(query);
  return {
    items: rows.map(toProduct),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

class DuplicateSkuError extends Error {
  constructor() {
    super('A product with this SKU already exists');
    this.name = 'DuplicateSkuError';
  }
}

class ProductNotFoundError extends Error {
  constructor() {
    super('Product not found');
    this.name = 'ProductNotFoundError';
  }
}

// Thrown when a correction would make stock negative. currentStock lets the caller show the real number.
class InsufficientStockError extends Error {
  constructor(currentStock) {
    super('Not enough stock for this adjustment');
    this.name = 'InsufficientStockError';
    this.currentStock = currentStock;
  }
}

// Thrown when a correction would go past the largest quantity the stock column can hold.
class StockLimitError extends Error {
  constructor(currentStock) {
    super('This adjustment would exceed the maximum stock quantity');
    this.name = 'StockLimitError';
    this.currentStock = currentStock;
  }
}

// True only for a duplicate on the SKU unique key (not for any other kind of database error).
function isDuplicateSku(err) {
  return err && err.code === 'ER_DUP_ENTRY' && String(err.sqlMessage || '').includes('uq_products_sku');
}

// "10.5" and "10.50" are the same price. The audit log always stores two decimal places.
function normalisePrice(price) {
  return formatCents(toCents(price));
}

// Compares the stored product with the fields an edit sends. Returns null when nothing really changes, otherwise the
// details for the audit log. PRIVACY: the log records WHICH fields changed (sku, name, price) and, for the price only,
// the old and new value, which is validated digits. The SKU and name are free text, so their values are never
// copied into the log (Activity shows the product's current SKU and name from the products table).
function describeProductChanges(before, data) {
  const changedFields = [];
  let priceChange = null;
  if (data.sku !== undefined && data.sku !== before.sku) {
    changedFields.push('sku');
  }
  if (data.name !== undefined && data.name !== before.name) {
    changedFields.push('name');
  }
  if (data.price !== undefined && toCents(data.price) !== toCents(before.price)) {
    changedFields.push('price');
    priceChange = { from: normalisePrice(before.price), to: normalisePrice(data.price) };
  }
  if (changedFields.length === 0) {
    return null;
  }
  return priceChange ? { changedFields, changes: { price: priceChange } } : { changedFields };
}

// Saves the product and its audit record in ONE transaction, then reads the product back so the response contains
// the values MySQL generated. adminId is the signed-in administrator.
async function createProduct(data, adminId) {
  let id;
  try {
    id = await withTransaction(async (connection) => {
      const newId = await productRepository.create(data, connection);
      await auditService.record(connection, {
        adminId,
        eventType: 'PRODUCT_CREATED',
        entityId: newId,
        // Only the validated price: the SKU and name are free text and are not copied into the log.
        details: { price: normalisePrice(data.price) },
      });
      return newId;
    });
  } catch (err) {
    if (isDuplicateSku(err)) {
      throw new DuplicateSkuError();
    }
    throw err;
  }

  const row = await productRepository.findById(id);
  if (!row) {
    throw new Error('Created product could not be read back');
  }
  return toProduct(row);
}

async function getExistingProduct(id) {
  const row = await productRepository.findById(id);
  if (!row) {
    throw new ProductNotFoundError();
  }
  return toProduct(row);
}

// Changes the given fields (sku, name, price) and, if something really changed, records it in the audit log in the
// same transaction. The product row is locked first, so the old values that are compared are the real ones. Then the
// product is read back.
async function updateProduct(id, data, adminId) {
  try {
    await withTransaction(async (connection) => {
      const before = await productRepository.findByIdForUpdate(connection, id);
      if (!before) {
        throw new ProductNotFoundError();
      }
      await productRepository.update(id, data, connection);
      const details = describeProductChanges(before, data);
      if (details) {
        await auditService.record(connection, { adminId, eventType: 'PRODUCT_UPDATED', entityId: id, details });
      }
    });
  } catch (err) {
    if (isDuplicateSku(err)) {
      throw new DuplicateSkuError();
    }
    throw err;
  }
  return getExistingProduct(id);
}

// Deactivating hides a product from the default list; nothing is deleted, so order history stays intact.
// Repeating a request that changes nothing is harmless and is not recorded in the audit log.
async function setProductActive(id, isActive, adminId) {
  await withTransaction(async (connection) => {
    const before = await productRepository.findByIdForUpdate(connection, id);
    if (!before) {
      throw new ProductNotFoundError();
    }
    if (Boolean(before.is_active) !== isActive) {
      await productRepository.setActive(id, isActive, connection);
      await auditService.record(connection, {
        adminId,
        eventType: isActive ? 'PRODUCT_ACTIVATED' : 'PRODUCT_DEACTIVATED',
        entityId: id,
      });
    }
  });
  return getExistingProduct(id);
}

function toAdjustment(row) {
  return {
    id: Number(row.id),
    productId: Number(row.product_id),
    quantityDelta: Number(row.quantity_delta),
    reason: row.reason,
    adminId: Number(row.admin_id),
    createdAt: row.created_at,
  };
}

// Applies a signed stock correction and records it in the history, all in ONE transaction: either both
// happen or neither does. The product row is locked first, so the number we check is the number we change
// (two simultaneous corrections cannot both pass the check and push stock below zero).
// Works on inactive products too: a recount is still a valid correction.
async function adjustStock({ productId, delta, reason, adminId }) {
  const adjustment = await withTransaction(async (connection) => {
    const locked = await productRepository.lockForUpdate(connection, productId);
    if (!locked) {
      throw new ProductNotFoundError();
    }

    const current = Number(locked.stock_quantity);
    const next = current + delta;
    if (next < 0) {
      throw new InsufficientStockError(current);
    }
    if (next > MAX_STOCK_QUANTITY) {
      throw new StockLimitError(current);
    }

    await productRepository.setStockQuantity(connection, productId, next);
    return stockAdjustmentRepository.insert(connection, { productId, quantityDelta: delta, reason, adminId });
  });

  return { product: await getExistingProduct(productId), adjustment: toAdjustment(adjustment) };
}

// One page of a product's stock history, newest first. An unknown product is a 404, so "no history yet"
// (an empty list) can be told apart from "no such product". Inactive products have history too.
async function listStockAdjustments(productId, query) {
  if (!(await productRepository.findById(productId))) {
    throw new ProductNotFoundError();
  }
  const { rows, total } = await stockAdjustmentRepository.listByProduct(productId, query);
  return {
    items: rows.map(toAdjustment),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

module.exports = {
  listProducts,
  createProduct,
  updateProduct,
  setProductActive,
  adjustStock,
  listStockAdjustments,
  DuplicateSkuError,
  InsufficientStockError,
  StockLimitError,
  ProductNotFoundError,
};
