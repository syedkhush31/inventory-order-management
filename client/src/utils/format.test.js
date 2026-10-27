import { expect, test } from 'vitest';
import { formatPrice, formatQuantity } from './format.js';

test('formatPrice keeps two decimals and adds thousands separators without using floats', () => {
  expect(formatPrice('19.99')).toBe('19.99');
  expect(formatPrice('189.00')).toBe('189.00');
  expect(formatPrice('1234.5')).toBe('1,234.50');
  expect(formatPrice('1234567.89')).toBe('1,234,567.89');
  expect(formatPrice('0.10')).toBe('0.10');
  expect(formatPrice('7')).toBe('7.00');
});

test('formatQuantity groups thousands', () => {
  expect(formatQuantity(0)).toBe('0');
  expect(formatQuantity(1200)).toBe('1,200');
});
