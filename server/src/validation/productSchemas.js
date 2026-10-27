const { z } = require('zod');

const PRODUCT_STATUSES = ['active', 'inactive', 'all'];
// The only sort keys a client may ask for. The repository maps each one to a fixed column name.
const PRODUCT_SORT_KEYS = ['sku', 'name', 'price', 'stockQuantity', 'updatedAt'];
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 100;

// Validates the query string of GET /api/products. Anything outside these rules is rejected (400).
const productListQuerySchema = z.object({
  q: z.string().trim().max(MAX_SEARCH_LENGTH).default(''),
  status: z.enum(PRODUCT_STATUSES).default('active'),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
  sort: z.enum(PRODUCT_SORT_KEYS).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

// ---- Creating a product (POST /api/products) ----
// Limits come from the products table: sku VARCHAR(64), name VARCHAR(255), price DECIMAL(10,2),
// stock_quantity INT UNSIGNED.
const SKU_PATTERN = /^[A-Za-z0-9\-_./]+$/;
const PRICE_PATTERN = /^\d{1,8}(\.\d{1,2})?$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_SKU_LENGTH = 64;
const MAX_NAME_LENGTH = 255;
const MAX_STOCK_QUANTITY = 4_294_967_295;

// strictObject: any property that is not listed here (id, isActive, createdAt, ...) is rejected.
const createProductSchema = z.strictObject({
  sku: z.string().trim().min(1).max(MAX_SKU_LENGTH).regex(SKU_PATTERN),
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_NAME_LENGTH)
    .refine((value) => !CONTROL_CHARACTERS.test(value)),
  // Price must arrive as text such as "19.99" so money is never turned into a floating-point number.
  price: z.string().regex(PRICE_PATTERN),
  // Left out (or sent as "") means 0.
  stockQuantity: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.number().int().min(0).max(MAX_STOCK_QUANTITY).default(0)
  ),
});

module.exports = {
  productListQuerySchema,
  createProductSchema,
  PRODUCT_STATUSES,
  PRODUCT_SORT_KEYS,
  MAX_PAGE_SIZE,
  MAX_STOCK_QUANTITY,
};
