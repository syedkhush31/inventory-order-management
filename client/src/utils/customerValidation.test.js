import { describe, expect, test } from 'vitest';
import { validateCustomerForm } from './customerValidation.js';

const valid = { name: 'Ann Lee', email: 'ann@example.com', phone: '+1 (555) 010-2000', address: '1 Main St' };
const check = (overrides) => validateCustomerForm({ ...valid, ...overrides });

describe('valid input', () => {
  test('is accepted and returned ready to send', () => {
    expect(check({})).toEqual({ values: valid, errors: {} });
  });

  test('trims text and lower-cases the email', () => {
    expect(check({ name: '  Ann ', email: '  ANN@Example.COM ', address: ' 1 Main St ' }).values).toMatchObject({
      name: 'Ann',
      email: 'ann@example.com',
      address: '1 Main St',
    });
  });

  test('a blank phone or address becomes null', () => {
    expect(check({ phone: '   ', address: '' }).values).toMatchObject({ phone: null, address: null });
  });

  test('accepts the boundary lengths', () => {
    expect(check({ name: 'n'.repeat(255) }).values).not.toBeNull();
    expect(check({ phone: '1'.repeat(32) }).values).not.toBeNull();
    expect(check({ address: 'a'.repeat(500) }).values).not.toBeNull();
    expect(check({ email: `${'a'.repeat(243)}@example.com` }).values).not.toBeNull();
  });
});

describe('invalid input', () => {
  test.each([
    ['blank name', { name: '  ' }, 'name', 'Enter the customer name.'],
    ['long name', { name: 'n'.repeat(256) }, 'name', 'Name must be 255 characters or fewer.'],
    ['name with a control character', { name: 'a\u0007b' }, 'name', 'Name cannot contain control characters.'],
    ['blank email', { email: '' }, 'email', 'Enter an email address.'],
    ['email without @', { email: 'ann.example.com' }, 'email', 'Enter a valid email address, such as name@example.com.'],
    ['email without a dot in the domain', { email: 'ann@example' }, 'email', 'Enter a valid email address, such as name@example.com.'],
    ['email with a space', { email: 'a nn@example.com' }, 'email', 'Enter a valid email address, such as name@example.com.'],
    ['long email', { email: `${'a'.repeat(244)}@example.com` }, 'email', 'Email must be 255 characters or fewer.'],
    ['phone with letters', { phone: '555-CALL' }, 'phone', /Use digits and/],
    ['phone with too few digits', { phone: '+1' }, 'phone', /at least 3 digits/],
    ['long phone', { phone: '1'.repeat(33) }, 'phone', 'Phone must be 32 characters or fewer.'],
    ['long address', { address: 'a'.repeat(501) }, 'address', 'Address must be 500 characters or fewer.'],
    ['address with a line break', { address: 'a\nb' }, 'address', 'Address cannot contain control characters or line breaks.'],
  ])('%s', (_label, overrides, field, message) => {
    const { values, errors } = check(overrides);
    expect(values).toBeNull();
    if (message instanceof RegExp) expect(errors[field]).toMatch(message);
    else expect(errors[field]).toBe(message);
    expect(Object.keys(errors)).toEqual([field]);
  });

  test('reports every problem at once', () => {
    const { errors } = validateCustomerForm({ name: '', email: '', phone: 'x', address: '' });
    expect(Object.keys(errors)).toEqual(['name', 'email', 'phone']);
  });
});
