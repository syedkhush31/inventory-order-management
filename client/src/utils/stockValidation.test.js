import { describe, expect, test } from 'vitest';
import { MAX_STOCK_QUANTITY, previewStock, validateStockAdjustment } from './productValidation.js';

const check = (delta, reason = 'Recount', current = 10) => validateStockAdjustment({ delta, reason }, current);

describe('previewStock', () => {
  test.each([
    ['5', 10, 15],
    ['+5', 10, 15],
    ['-3', 10, 7],
    [' -10 ', 10, 0],
    ['-11', 10, -1],
  ])('%p on %i gives %i', (text, current, expected) => {
    expect(previewStock(text, current)).toBe(expected);
  });

  test.each(['', '-', '1.5', 'abc', '1e3', '--2'])('is null for %p', (text) => {
    expect(previewStock(text, 10)).toBeNull();
  });
});

describe('validateStockAdjustment', () => {
  test('accepts a valid change and returns numbers and trimmed text', () => {
    expect(check(' -3 ', '  Damaged  ')).toEqual({ values: { delta: -3, reason: 'Damaged' }, errors: {} });
    expect(check('+5').values.delta).toBe(5);
  });

  test('removing exactly all the stock is allowed', () => {
    expect(check('-10').values.delta).toBe(-10);
  });

  test('refuses to go below zero and says how many are on hand', () => {
    const { values, errors } = check('-11');
    expect(values).toBeNull();
    expect(errors.delta).toBe('Stock cannot go below 0. Only 10 on hand.');
  });

  test('refuses to go above the maximum', () => {
    expect(check('1', 'r', MAX_STOCK_QUANTITY).errors.delta).toMatch(/Stock cannot be more than 4,294,967,295/);
    expect(check('1', 'r', MAX_STOCK_QUANTITY - 1).values.delta).toBe(1);
  });

  test.each([
    ['empty', '', 'Enter the change in stock, such as 5 or -3.'],
    ['text', 'abc', 'Enter a whole number such as 5 or -3.'],
    ['decimal', '2.5', 'Enter a whole number such as 5 or -3.'],
    ['zero', '0', 'The change cannot be 0.'],
    ['negative zero', '-0', 'The change cannot be 0.'],
    ['too large', '2147483648', 'That change is too large.'],
    ['absurdly large', '9'.repeat(30), 'That change is too large.'],
  ])('rejects a %s change', (_label, delta, message) => {
    expect(check(delta).errors.delta).toBe(message);
  });

  test.each([
    ['empty', '', 'Enter a reason for the correction.'],
    ['blank', '   ', 'Enter a reason for the correction.'],
    ['too long', 'r'.repeat(256), 'The reason must be 255 characters or fewer.'],
    ['control character', 'a\u0007b', 'The reason cannot contain control characters.'],
  ])('rejects a %s reason', (_label, reason, message) => {
    expect(check('1', reason).errors.reason).toBe(message);
  });

  test('reports both fields at once', () => {
    expect(Object.keys(check('', '').errors)).toEqual(['delta', 'reason']);
  });
});
