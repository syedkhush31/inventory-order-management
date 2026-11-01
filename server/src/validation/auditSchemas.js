const { z } = require('zod');

// Every kind of event that may be written to audit_log. This list must match the event_type ENUM in
// database/schema.sql and migration 003 (a unit test compares them). Orders and manual stock corrections are NOT here:
// order_status_history and stock_adjustments already record them.
const EVENT_TYPES = [
  'PRODUCT_CREATED',
  'PRODUCT_UPDATED',
  'PRODUCT_ACTIVATED',
  'PRODUCT_DEACTIVATED',
  'CUSTOMER_CREATED',
  'CUSTOMER_UPDATED',
  'CUSTOMER_ACTIVATED',
  'CUSTOMER_DEACTIVATED',
  'ACCOUNT_PROFILE_UPDATED',
  'ACCOUNT_PASSWORD_CHANGED',
  'SETTINGS_UPDATED',
];

// The entity type is decided here, never by the caller, so an event and its entity can not disagree.
const ENTITY_TYPE_BY_EVENT = {
  PRODUCT_CREATED: 'PRODUCT',
  PRODUCT_UPDATED: 'PRODUCT',
  PRODUCT_ACTIVATED: 'PRODUCT',
  PRODUCT_DEACTIVATED: 'PRODUCT',
  CUSTOMER_CREATED: 'CUSTOMER',
  CUSTOMER_UPDATED: 'CUSTOMER',
  CUSTOMER_ACTIVATED: 'CUSTOMER',
  CUSTOMER_DEACTIVATED: 'CUSTOMER',
  ACCOUNT_PROFILE_UPDATED: 'ACCOUNT',
  ACCOUNT_PASSWORD_CHANGED: 'ACCOUNT',
  SETTINGS_UPDATED: 'SETTINGS',
};

const MAX_DETAILS_BYTES = 2048;
const PRICE_PATTERN = /^\d{1,8}(\.\d{1,2})?$/;
const LOW_STOCK_THRESHOLD_KEY = 'low_stock_threshold';
const MAX_LOW_STOCK_THRESHOLD = 1000;

// PRIVACY RULE: the audit log never holds text that a person typed. Every string that can be stored is one of
//   - a fixed field name from a short list (an enum below),
//   - a price that must be digits with at most two decimals, or
//   - the one allowed setting key.
// There is no free-text field at all, so there is nothing for a password, hash, token, email address, phone number or
// postal address to hide in, and nothing for a filter to miss. This is enforced by the schemas (a text field that is
// not an enum, a fixed literal or a digits-only price is not allowed), not by searching text for bad patterns.
// A unit test walks every accepted value and checks it is one of those three kinds.
const idNumber = z.number().int().min(1).max(999_999_999_999_999);
const priceText = z.string().regex(PRICE_PATTERN);

const uniqueList = (items) => new Set(items).size === items.length;
const fieldList = (names) => z.array(z.enum(names)).min(1).max(names.length).refine(uniqueList);

const PRODUCT_FIELDS = ['sku', 'name', 'price'];

// Detail rules per event. z.null() means the event stores no details at all.
const DETAIL_SCHEMAS = {
  // The SKU and name are NOT stored: they are free text, and Activity shows the product's current SKU and name from
  // the products table. Only the price, which is validated digits, is kept.
  PRODUCT_CREATED: z.strictObject({ price: priceText }),
  // changedFields names what changed. Only the price also carries old and new values; for sku and name the log says
  // that they changed, never what they were changed from or to.
  PRODUCT_UPDATED: z
    .strictObject({
      changedFields: fieldList(PRODUCT_FIELDS),
      changes: z.strictObject({ price: z.strictObject({ from: priceText, to: priceText }) }).optional(),
    })
    .refine((details) => !details.changes || details.changedFields.includes('price'), {
      message: 'changes.price needs price in changedFields',
    }),
  PRODUCT_ACTIVATED: z.null(),
  PRODUCT_DEACTIVATED: z.null(),
  CUSTOMER_CREATED: z.null(),
  // Field names only: a customer's name, email, phone and address are personal data and are never copied here.
  CUSTOMER_UPDATED: z.strictObject({ changedFields: fieldList(['name', 'email', 'phone', 'address']) }),
  CUSTOMER_ACTIVATED: z.null(),
  CUSTOMER_DEACTIVATED: z.null(),
  ACCOUNT_PROFILE_UPDATED: z.strictObject({ changedFields: fieldList(['displayName', 'email']) }),
  ACCOUNT_PASSWORD_CHANGED: z.null(),
  SETTINGS_UPDATED: z.strictObject({
    key: z.literal(LOW_STOCK_THRESHOLD_KEY),
    from: z.number().int().min(0).max(MAX_LOW_STOCK_THRESHOLD),
    to: z.number().int().min(0).max(MAX_LOW_STOCK_THRESHOLD),
  }),
};

class AuditValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuditValidationError';
  }
}

// Checks one event against the allowlists and returns exactly what may be stored:
// { eventType, entityType, entityId, details } where details is null or a plain object. Throws AuditValidationError.
// Anything that is not on the allowlist is refused, never silently dropped or "cleaned".
function validateAuditEvent({ eventType, entityId, details }) {
  if (!EVENT_TYPES.includes(eventType)) {
    throw new AuditValidationError('Unknown audit event type');
  }
  const entityType = ENTITY_TYPE_BY_EVENT[eventType];

  if (entityType === 'SETTINGS') {
    if (entityId !== null && entityId !== undefined) throw new AuditValidationError('Settings events have no entity id');
  } else if (!idNumber.safeParse(entityId).success) {
    throw new AuditValidationError('A valid entity id is required');
  }

  const given = details === undefined ? null : details;
  const parsed = DETAIL_SCHEMAS[eventType].safeParse(given);
  if (!parsed.success) {
    throw new AuditValidationError('Audit details are not allowed for this event');
  }
  const cleaned = parsed.data === undefined ? null : JSON.parse(JSON.stringify(parsed.data)); // drops undefined keys
  if (cleaned !== null && Buffer.byteLength(JSON.stringify(cleaned), 'utf8') > MAX_DETAILS_BYTES) {
    throw new AuditValidationError('Audit details are too large');
  }
  return { eventType, entityType, entityId: entityType === 'SETTINGS' ? null : entityId, details: cleaned };
}

module.exports = {
  EVENT_TYPES,
  ENTITY_TYPE_BY_EVENT,
  DETAIL_SCHEMAS,
  AuditValidationError,
  MAX_DETAILS_BYTES,
  validateAuditEvent,
};
