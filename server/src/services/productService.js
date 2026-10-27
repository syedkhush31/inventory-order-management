// Turns database rows into the shape the API returns.
const productRepository = require('../repositories/productRepository');

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

// True only for a duplicate on the SKU unique key (not for any other kind of database error).
function isDuplicateSku(err) {
  return err && err.code === 'ER_DUP_ENTRY' && String(err.sqlMessage || '').includes('uq_products_sku');
}

// Saves the product, then reads it back so the response contains the values MySQL generated.
async function createProduct(data) {
  let id;
  try {
    id = await productRepository.create(data);
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

module.exports = { listProducts, createProduct, DuplicateSkuError };
