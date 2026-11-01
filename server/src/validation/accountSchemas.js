const { z } = require('zod');
const { emailField, withinByteLimit } = require('./authSchemas');

const MAX_DISPLAY_NAME_LENGTH = 100;
const MIN_NEW_PASSWORD_LENGTH = 12; // the same minimum as creating an administrator
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

// A display name is optional free text. null or an empty string clears it. Control characters are refused.
const displayNameField = z
  .string()
  .trim()
  .max(MAX_DISPLAY_NAME_LENGTH)
  .refine((value) => !CONTROL_CHARACTERS.test(value))
  .nullable()
  .transform((value) => (value === '' ? null : value));

// The password the administrator types to prove it is really them. bcrypt only uses the first 72 bytes, so more is refused.
const passwordAnswerField = z.string().min(1).refine(withinByteLimit);

// ---- PATCH /api/account/profile ----
// Only displayName and email can be changed, and only the fields that are sent. Changing the email needs
// currentPassword; the service enforces that, because it depends on whether the email really changes.
// strictObject: any other property (id, isActive, passwordHash, tokenVersion, ...) is rejected, never ignored.
const updateProfileSchema = z
  .strictObject({
    displayName: displayNameField.optional(),
    email: emailField.optional(),
    currentPassword: passwordAnswerField.optional(),
  })
  .refine((body) => body.displayName !== undefined || body.email !== undefined, {
    message: 'Send displayName or email',
    path: ['body'],
  });

// ---- POST /api/account/password ----
const changePasswordSchema = z
  .strictObject({
    currentPassword: passwordAnswerField,
    newPassword: z.string().min(MIN_NEW_PASSWORD_LENGTH).refine(withinByteLimit),
  })
  .refine((body) => body.newPassword !== body.currentPassword, {
    message: 'The new password must be different',
    path: ['newPassword'],
  });

module.exports = { updateProfileSchema, changePasswordSchema, MAX_DISPLAY_NAME_LENGTH, MIN_NEW_PASSWORD_LENGTH };
