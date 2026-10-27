const { z } = require('zod');

// bcrypt only uses the first 72 bytes of a password, so longer input is rejected.
const MAX_PASSWORD_BYTES = 72;
const withinByteLimit = (value) => Buffer.byteLength(value, 'utf8') <= MAX_PASSWORD_BYTES;

const email = z.string().trim().toLowerCase().pipe(z.email().max(255));

const loginSchema = z.object({
  email,
  password: z.string().min(1).refine(withinByteLimit),
});

const createAdminSchema = z.object({
  email,
  password: z.string().min(12).refine(withinByteLimit),
});

module.exports = { loginSchema, createAdminSchema, MAX_PASSWORD_BYTES };
