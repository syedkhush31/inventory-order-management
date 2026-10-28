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

// Field rules shared by "create" and "edit", so the two can never drift apart.
const skuField = z.string().trim().min(1).max(MAX_SKU_LENGTH).regex(SKU_PATTERN);
const nameField = z
  .string()
  .trim()
  .min(1)
  .max(MAX_NAME_LENGTH)
  .refine((value) => !CONTROL_CHARACTERS.test(value));
// Price must arrive as text such as "19.99" so money is never turned into a floating-point number.
const priceField = z.string().regex(PRICE_PATTERN);

// strictObject: any property that is not listed here (id, isActive, createdAt, ...) is rejected.
const createProductSchema = z.strictObject({
  sku: skuField,
  name: nameField,
  price: priceField,
  // Left out (or sent as "") means 0.
  stockQuantity: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.number().int().min(0).max(MAX_STOCK_QUANTITY).default(0)
  ),
});

// ---- Editing a product (PATCH /api/products/:id) ----
// Only sku, name and price can be edited, and only the fields that are sent are changed.
// Stock and the active flag have their own routes, so they are rejected here like any unknown property.
const updateProductSchema = z
  .strictObject({
    sku: skuField.optional(),
    name: nameField.optional(),
    price: priceField.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Send at least one field to change',
    path: ['body'],
    // Only when nothing else is wrong, so a rejected unknown property is reported by its own name alone.
    when: (payload) => payload.issues.length === 0,
  });

// ---- Product id in the URL ----
// A positive whole number of at most 15 digits, so it is always a safe integer.
const productIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,14}$/)
  .transform(Number);

// ---- Correcting stock (POST /api/products/:id/stock-adjustments) ----
// delta is the signed change (+5 adds five, -3 removes three). It must fit the INT column that stores it.
// reason is kept in the history, so it is required.
const MAX_STOCK_DELTA = 2_147_483_647;
const MAX_REASON_LENGTH = 255;

const stockAdjustmentSchema = z.strictObject({
  delta: z
    .number()
    .int()
    .min(-MAX_STOCK_DELTA)
    .max(MAX_STOCK_DELTA)
    .refine((value) => value !== 0),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(MAX_REASON_LENGTH)
    .refine((value) => !CONTROL_CHARACTERS.test(value)),
});

// ---- Stock history (GET /api/products/:id/stock-adjustments) ----
// Same paging rules as the product list; a smaller default because each row is a short event.
const stockHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(10),
});

module.exports = {
  productListQuerySchema,
  createProductSchema,
  updateProductSchema,
  productIdSchema,
  stockAdjustmentSchema,
  stockHistoryQuerySchema,
  PRODUCT_STATUSES,
  PRODUCT_SORT_KEYS,
  MAX_PAGE_SIZE,
  MAX_STOCK_QUANTITY,
  MAX_STOCK_DELTA,
  MAX_REASON_LENGTH,
};
