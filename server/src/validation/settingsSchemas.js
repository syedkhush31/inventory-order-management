const { z } = require('zod');

// The one preference that exists so far. Keep the key and the range in step with validation/auditSchemas.js (a unit
// test checks they agree), because a change to this setting is recorded in the audit log.
const LOW_STOCK_THRESHOLD_KEY = 'low_stock_threshold';
const DEFAULT_LOW_STOCK_THRESHOLD = 5;
const MIN_LOW_STOCK_THRESHOLD = 0;
const MAX_LOW_STOCK_THRESHOLD = 1000;

// PATCH /api/settings  { lowStockThreshold: 8 }
// A whole JSON number from 0 to 1000. Text such as "8" is refused. strictObject: any other property is rejected.
const updateSettingsSchema = z.strictObject({
  lowStockThreshold: z.number().int().min(MIN_LOW_STOCK_THRESHOLD).max(MAX_LOW_STOCK_THRESHOLD),
});

module.exports = {
  updateSettingsSchema,
  LOW_STOCK_THRESHOLD_KEY,
  DEFAULT_LOW_STOCK_THRESHOLD,
  MIN_LOW_STOCK_THRESHOLD,
  MAX_LOW_STOCK_THRESHOLD,
};
