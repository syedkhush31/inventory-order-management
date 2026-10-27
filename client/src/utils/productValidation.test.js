import { describe, expect, test } from 'vitest';
import { MAX_STOCK_QUANTITY, validateProductForm } from './productValidation.js';

const input = (overrides = {}) => ({ sku: 'SKU-1', name: 'Mouse', price: '19.99', stock: '5', ...overrides });
const errorsFor = (overrides) => validateProductForm(input(overrides)).errors;

describe('valid input', () => {
  test('returns ready-to-send values with trimmed text and a numeric stock', () => {
    const { values, errors } = validateProductForm({ sku: '  Ab-1.2/x_  ', name: '  Wireless Mouse ', price: ' 19.99 ', stock: ' 12 ' });
    expect(errors).toEqual({});
    expect(values).toEqual({ sku: 'Ab-1.2/x_', name: 'Wireless Mouse', price: '19.99', stockQuantity: 12 });
  });

  test('keeps the price as the exact text', () => {
    expect(validateProductForm(input({ price: '0.10' })).values.price).toBe('0.10');
    expect(validateProductForm(input({ price: '99999999.99' })).values.price).toBe('99999999.99');
  });

  test('a blank stock field means 0', () => {
    expect(validateProductForm(input({ stock: '' })).values.stockQuantity).toBe(0);
    expect(validateProductForm(input({ stock: '   ' })).values.stockQuantity).toBe(0);
  });

  test('accepts the stock limits', () => {
    expect(validateProductForm(input({ stock: '0' })).values.stockQuantity).toBe(0);
    expect(validateProductForm(input({ stock: String(MAX_STOCK_QUANTITY) })).values.stockQuantity).toBe(4294967295);
  });
});

describe('sku', () => {
  test.each([
    ['', 'Enter a SKU.'],
    ['   ', 'Enter a SKU.'],
    ['AB 12', 'SKU cannot contain spaces.'],
    ['AB\t12', 'SKU cannot contain spaces.'],
    ['AB#12', 'Use only letters, digits, hyphens, underscores, periods and slashes.'],
    ['CAFÉ', 'Use only letters, digits, hyphens, underscores, periods and slashes.'],
    ['X'.repeat(65), 'SKU must be 64 characters or fewer.'],
  ])('"%s" gives "%s"', (sku, message) => {
    expect(errorsFor({ sku }).sku).toBe(message);
  });

  test('64 characters is fine', () => {
    expect(errorsFor({ sku: 'X'.repeat(64) }).sku).toBeUndefined();
  });
});

describe('name', () => {
  test.each([
    ['', 'Enter a product name.'],
    ['    ', 'Enter a product name.'],
    ['x'.repeat(256), 'Product name must be 255 characters or fewer.'],
    ['bad\u0007name', 'Product name cannot contain control characters.'],
    ['two\nlines', 'Product name cannot contain control characters.'],
  ])('%j is rejected', (name, message) => {
    expect(errorsFor({ name }).name).toBe(message);
  });

  test('255 characters and non-ASCII text are fine', () => {
    expect(errorsFor({ name: 'x'.repeat(255) }).name).toBeUndefined();
    expect(errorsFor({ name: 'Café “Monitor” — 27"' }).name).toBeUndefined();
  });
});

describe('price', () => {
  test('blank price asks for a price', () => {
    expect(errorsFor({ price: '' }).price).toBe('Enter a price.');
  });

  test.each(['-1', '+5', '1.001', '5.', '.5', '1e3', '1,5', '$5', 'abc', '100000000', '1 2'])('"%s" is rejected', (price) => {
    expect(errorsFor({ price }).price).toMatch(/^Enter a price such as 19\.99/);
  });

  test.each(['0', '0.5', '7', '19.99', '99999999', '99999999.99'])('"%s" is accepted', (price) => {
    expect(errorsFor({ price }).price).toBeUndefined();
  });
});

describe('stock', () => {
  test.each(['-1', '1.5', '1e3', 'ten', '1,000', '+3', ' 2 3'])('"%s" is not a whole number', (stock) => {
    expect(errorsFor({ stock }).stock).toBe('Enter a whole number, 0 or more.');
  });

  test.each(['4294967296', '99999999999', '12345678901234567890'])('"%s" is over the limit', (stock) => {
    expect(errorsFor({ stock }).stock).toBe('Stock cannot be more than 4,294,967,295.');
  });
});

describe('several problems', () => {
  test('reports every bad field at once and returns no values', () => {
    const result = validateProductForm({ sku: '', name: '', price: 'x', stock: '-1' });
    expect(result.values).toBeNull();
    expect(Object.keys(result.errors).sort()).toEqual(['name', 'price', 'sku', 'stock']);
  });
});
