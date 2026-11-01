const { z } = require('zod');

// The groups the Activity page can filter by. 'order' and 'stock' come from order_status_history and the MANUAL rows
// of stock_adjustments; the rest are the entity types in audit_log.
const ACTIVITY_TYPES = ['all', 'order', 'stock', 'product', 'customer', 'account', 'settings'];
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 100;

// An empty value in the query string (for example "from=") means "not given".
const optionalInstant = z.preprocess((value) => (value === '' ? undefined : value), z.iso.datetime().optional());

// Validates the query string of GET /api/activity. Anything outside these rules is rejected (400).
// from is inclusive and to is exclusive; both are UTC instants such as 2026-11-01T00:00:00.000Z.
const activityQuerySchema = z
  .object({
    q: z.string().trim().max(MAX_SEARCH_LENGTH).default(''),
    type: z.enum(ACTIVITY_TYPES).default('all'),
    from: optionalInstant,
    to: optionalInstant,
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
  })
  .refine((query) => !query.from || !query.to || new Date(query.from) < new Date(query.to), {
    message: 'from must be earlier than to',
    path: ['to'],
  });

module.exports = { activityQuerySchema, ACTIVITY_TYPES, MAX_PAGE_SIZE, MAX_SEARCH_LENGTH };
