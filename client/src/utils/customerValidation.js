// Checks the customer form before anything is sent. The rules match the server's rules; the server still validates
// everything again, so these checks are only for fast, friendly feedback. The email check is deliberately simple
// ("something@something.something"): the server applies the strict email rules.

export const MAX_NAME_LENGTH = 255;
export const MAX_EMAIL_LENGTH = 255;
export const MAX_PHONE_LENGTH = 32;
export const MAX_ADDRESS_LENGTH = 500;
export const MIN_PHONE_DIGITS = 3;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[0-9+()\-.\s]+$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

// The fields in the order they appear on screen, used to focus the first problem.
export const CUSTOMER_FIELD_ORDER = ['name', 'email', 'phone', 'address'];

// input: { name, email, phone, address } as typed (all strings).
// Returns { values, errors }. When there are errors, values is null.
// values is ready to send: the email is lower-cased and a blank phone or address becomes null.
export function validateCustomerForm(input) {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const phone = input.phone.trim();
  const address = input.address.trim();
  const errors = {};

  if (name === '') {
    errors.name = 'Enter the customer name.';
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.name = `Name must be ${MAX_NAME_LENGTH} characters or fewer.`;
  } else if (CONTROL_CHARACTERS.test(name)) {
    errors.name = 'Name cannot contain control characters.';
  }

  if (email === '') {
    errors.email = 'Enter an email address.';
  } else if (email.length > MAX_EMAIL_LENGTH) {
    errors.email = `Email must be ${MAX_EMAIL_LENGTH} characters or fewer.`;
  } else if (!EMAIL_PATTERN.test(email)) {
    errors.email = 'Enter a valid email address, such as name@example.com.';
  }

  if (phone !== '') {
    if (phone.length > MAX_PHONE_LENGTH) {
      errors.phone = `Phone must be ${MAX_PHONE_LENGTH} characters or fewer.`;
    } else if (!PHONE_PATTERN.test(phone) || phone.replace(/\D/g, '').length < MIN_PHONE_DIGITS) {
      errors.phone = `Use digits and + ( ) - . or spaces only, with at least ${MIN_PHONE_DIGITS} digits.`;
    }
  }

  if (address !== '') {
    if (address.length > MAX_ADDRESS_LENGTH) {
      errors.address = `Address must be ${MAX_ADDRESS_LENGTH} characters or fewer.`;
    } else if (CONTROL_CHARACTERS.test(address)) {
      errors.address = 'Address cannot contain control characters or line breaks.';
    }
  }

  if (Object.keys(errors).length > 0) {
    return { values: null, errors };
  }
  return { values: { name, email, phone: phone === '' ? null : phone, address: address === '' ? null : address }, errors };
}
