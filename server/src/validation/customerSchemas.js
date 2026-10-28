const { z } = require('zod');

const CUSTOMER_STATUSES = ['active', 'inactive', 'all'];
// The only sort keys a client may ask for. The repository maps each one to a fixed column name.
const CUSTOMER_SORT_KEYS = ['name', 'email', 'createdAt', 'updatedAt'];
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_LENGTH = 100;

// Validates the query string of GET /api/customers. Anything outside these rules is rejected (400).
const customerListQuerySchema = z.object({
  q: z.string().trim().max(MAX_SEARCH_LENGTH).default(''),
  status: z.enum(CUSTOMER_STATUSES).default('active'),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
  sort: z.enum(CUSTOMER_SORT_KEYS).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
});

// ---- Creating and editing a customer ----
// Limits come from the customers table: name VARCHAR(255), email VARCHAR(255) UNIQUE, phone VARCHAR(32) NULL,
// address VARCHAR(500) NULL.
const MAX_NAME_LENGTH = 255;
const MAX_EMAIL_LENGTH = 255;
const MAX_PHONE_LENGTH = 32;
const MAX_ADDRESS_LENGTH = 500;
const MIN_PHONE_DIGITS = 3;
const PHONE_PATTERN = /^[0-9+()\-.\s]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

const nameField = z
  .string()
  .trim()
  .min(1)
  .max(MAX_NAME_LENGTH)
  .refine((value) => !CONTROL_CHARACTERS.test(value));

// Same convention as the administrator login: trimmed and lower-cased, so "Ann@X.com" and "ann@x.com" are one address.
const emailField = z.string().trim().toLowerCase().pipe(z.email().max(MAX_EMAIL_LENGTH));

// Optional text columns: a blank string (or null) means "no value" and is stored as NULL.
const blankToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);

const phoneField = z.preprocess(
  blankToNull,
  z
    .string()
    .trim()
    .max(MAX_PHONE_LENGTH)
    .regex(PHONE_PATTERN)
    .refine((value) => value.replace(/\D/g, '').length >= MIN_PHONE_DIGITS)
    .nullable()
);

const addressField = z.preprocess(
  blankToNull,
  z
    .string()
    .trim()
    .max(MAX_ADDRESS_LENGTH)
    .refine((value) => !CONTROL_CHARACTERS.test(value))
    .nullable()
);

// strictObject: any property that is not listed here (id, isActive, createdAt, ...) is rejected.
const createCustomerSchema = z.strictObject({
  name: nameField,
  email: emailField,
  phone: phoneField.default(null),
  address: addressField.default(null),
});

// Only the fields that are sent are changed; send "" or null for phone/address to clear them.
// The active flag has its own routes, so it is rejected here like any unknown property.
const updateCustomerSchema = z
  .strictObject({
    name: nameField.optional(),
    email: emailField.optional(),
    phone: phoneField.optional(),
    address: addressField.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'Send at least one field to change',
    path: ['body'],
    // Only when nothing else is wrong, so a rejected unknown property is reported by its own name alone.
    when: (payload) => payload.issues.length === 0,
  });

// ---- Customer id in the URL ----
// A positive whole number of at most 15 digits, so it is always a safe integer.
const customerIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,14}$/)
  .transform(Number);

module.exports = {
  customerListQuerySchema,
  createCustomerSchema,
  updateCustomerSchema,
  customerIdSchema,
  CUSTOMER_STATUSES,
  CUSTOMER_SORT_KEYS,
  MAX_PAGE_SIZE,
  MAX_NAME_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_PHONE_LENGTH,
  MAX_ADDRESS_LENGTH,
};
