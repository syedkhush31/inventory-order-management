const { z } = require('zod');

// Matches the ENUM in the orders table. Phase 1 only ever creates PENDING orders.
const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
// The only sort keys a client may ask for. The repository maps each one to a fixed column name.
const ORDER_SORT_KEYS = ['id', 'createdAt', 'updatedAt', 'totalAmount', 'status', 'customerName'];
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 100;
const MAX_ITEMS_PER_ORDER = 50;
const MAX_QUANTITY_PER_ITEM = 10000;

// Validates the query string of GET /api/orders. Anything outside these rules is rejected (400).
const orderListQuerySchema = z.object({
  q: z.string().trim().max(MAX_SEARCH_LENGTH).default(''),
  status: z.enum([...ORDER_STATUSES, 'all']).default('all'),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
  sort: z.enum(ORDER_SORT_KEYS).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

// ---- Creating an order ----
// Ids are positive whole numbers of at most 15 digits, so they are always safe integers.
const idNumber = z.number().int().min(1).max(999_999_999_999_999);

// strictObject everywhere: a client-supplied price, total, status or any other property is rejected, never ignored.
const orderItemSchema = z.strictObject({
  productId: idNumber,
  quantity: z.number().int().min(1).max(MAX_QUANTITY_PER_ITEM),
});

const createOrderSchema = z.strictObject({
  customerId: idNumber,
  items: z
    .array(orderItemSchema)
    .min(1)
    .max(MAX_ITEMS_PER_ORDER)
    .refine((items) => new Set(items.map((item) => item.productId)).size === items.length),
});

// ---- Order id in the URL ----
const orderIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,14}$/)
  .transform(Number);

module.exports = {
  orderListQuerySchema,
  createOrderSchema,
  orderIdSchema,
  ORDER_STATUSES,
  ORDER_SORT_KEYS,
  MAX_PAGE_SIZE,
  MAX_ITEMS_PER_ORDER,
  MAX_QUANTITY_PER_ITEM,
};
