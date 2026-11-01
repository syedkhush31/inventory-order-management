// Checks the Settings forms before anything is sent. The rules match the server's rules (server/src/validation/
// accountSchemas.js and settingsSchemas.js); the server still validates everything again, so these checks are only for
// fast, friendly feedback. The email check is deliberately simple ("something@something.something").

export const MAX_DISPLAY_NAME_LENGTH = 100;
export const MAX_EMAIL_LENGTH = 255;
export const MIN_NEW_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_BYTES = 72; // bcrypt only uses the first 72 bytes, so the server refuses more
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;
export const MIN_LOW_STOCK_THRESHOLD = 0;
export const MAX_LOW_STOCK_THRESHOLD = 1000;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

// Length in bytes, as the server counts it (an accented letter or an emoji is more than one byte).
export function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

// The fields of the profile form in the order they appear on screen, used to focus the first problem.
export const PROFILE_FIELD_ORDER = ['displayName', 'email', 'currentPassword'];

// input: { displayName, email, currentPassword } as typed (strings).
// current: { displayName, email } as saved (displayName may be null).
// Returns { values, errors, changed }.
//   values  only what has changed, ready to send: { displayName?: string | null, email?: string, currentPassword?: string };
//           null when there are errors or nothing has changed
//   changed { displayName, email } booleans, so the form can show the password field only when the email is changing
//   errors  by field, plus errors.form when nothing has changed
export function validateProfileForm(input, current) {
  const displayName = input.displayName.trim();
  const email = input.email.trim().toLowerCase();
  const errors = {};

  const changed = {
    displayName: displayName !== (current.displayName ?? ''),
    email: email !== current.email,
  };

  if (changed.displayName) {
    if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      errors.displayName = `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`;
    } else if (CONTROL_CHARACTERS.test(displayName)) {
      errors.displayName = 'Display name cannot contain control characters.';
    }
  }

  if (changed.email) {
    if (email === '') {
      errors.email = 'Enter an email address.';
    } else if (email.length > MAX_EMAIL_LENGTH) {
      errors.email = `Email must be ${MAX_EMAIL_LENGTH} characters or fewer.`;
    } else if (!EMAIL_PATTERN.test(email)) {
      errors.email = 'Enter a valid email address, such as name@example.com.';
    }

    if (input.currentPassword === '') {
      errors.currentPassword = 'Enter your current password to change your email address.';
    } else if (byteLength(input.currentPassword) > MAX_PASSWORD_BYTES) {
      errors.currentPassword = 'That password is too long to be yours. Check it and try again.';
    }
  }

  if (!changed.displayName && !changed.email) {
    errors.form = 'Nothing has changed yet. Edit your display name or email first.';
  }

  if (Object.keys(errors).length > 0) {
    return { values: null, errors, changed };
  }

  const values = {};
  if (changed.displayName) values.displayName = displayName === '' ? null : displayName;
  if (changed.email) {
    values.email = email;
    values.currentPassword = input.currentPassword;
  }
  return { values, errors, changed };
}

export const PASSWORD_FIELD_ORDER = ['currentPassword', 'newPassword', 'confirmPassword'];

// input: { currentPassword, newPassword, confirmPassword } as typed. Returns { values, errors }.
// Passwords are never trimmed or changed: spaces are part of a password.
export function validatePasswordForm(input) {
  const errors = {};
  const { currentPassword, newPassword, confirmPassword } = input;

  if (currentPassword === '') {
    errors.currentPassword = 'Enter your current password.';
  } else if (byteLength(currentPassword) > MAX_PASSWORD_BYTES) {
    errors.currentPassword = 'That password is too long to be yours. Check it and try again.';
  }

  if (newPassword === '') {
    errors.newPassword = 'Enter a new password.';
  } else if (newPassword.length < MIN_NEW_PASSWORD_LENGTH) {
    errors.newPassword = `The new password must be at least ${MIN_NEW_PASSWORD_LENGTH} characters.`;
  } else if (byteLength(newPassword) > MAX_PASSWORD_BYTES) {
    errors.newPassword = `The new password is too long. Use at most ${MAX_PASSWORD_BYTES} bytes (about ${MAX_PASSWORD_BYTES} plain characters).`;
  } else if (newPassword === currentPassword) {
    errors.newPassword = 'The new password must be different from the current one.';
  }

  if (confirmPassword === '') {
    errors.confirmPassword = 'Type the new password again to confirm it.';
  } else if (confirmPassword !== newPassword) {
    errors.confirmPassword = 'The two new passwords do not match.';
  }

  if (Object.keys(errors).length > 0) {
    return { values: null, errors };
  }
  return { values: { currentPassword, newPassword }, errors };
}

// text: what was typed in the threshold box. Only whole numbers from 0 to 1000 are valid.
// Returns { value, error }; value is a number, or null when there is an error.
export function validateThreshold(text) {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { value: null, error: `Enter a whole number from ${MIN_LOW_STOCK_THRESHOLD} to ${MAX_LOW_STOCK_THRESHOLD}.` };
  }
  if (!/^\d{1,4}$/.test(trimmed)) {
    return { value: null, error: `Use a whole number from ${MIN_LOW_STOCK_THRESHOLD} to ${MAX_LOW_STOCK_THRESHOLD}, with no decimals, signs or letters.` };
  }
  const value = Number(trimmed);
  if (value < MIN_LOW_STOCK_THRESHOLD || value > MAX_LOW_STOCK_THRESHOLD) {
    return { value: null, error: `The threshold must be between ${MIN_LOW_STOCK_THRESHOLD} and ${MAX_LOW_STOCK_THRESHOLD}.` };
  }
  return { value, error: '' };
}
