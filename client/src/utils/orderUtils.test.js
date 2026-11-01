import { describe, expect, test } from 'vitest';
import {
  ACTIONS_BY_STATUS,
  centsToPrice,
  estimateLineCents,
  parseQuantity,
  priceToCents,
  validateOrder,
} from './orderUtils.js';

describe('money in cents', () => {
  test('converts price strings without floating point', () => {
    expect(priceToCents('19.99')).toBe(1999);
    expect(priceToCents('5')).toBe(500);
    expect(priceToCents('0.5')).toBe(50);
    expect(priceToCents('abc')).toBeNull();
    expect(priceToCents('-1.00')).toBeNull();
    expect(centsToPrice(1999)).toBe('19.99');
    expect(centsToPrice(5)).toBe('0.05');
    expect(estimateLineCents({ price: '0.10' }, '3')).toBe(30);
    expect(estimateLineCents({ price: '0.10' }, '0')).toBeNull();
    expect(estimateLineCents(undefined, '1')).toBeNull();
  });
});

describe('parseQuantity', () => {
  test.each([
    ['1', 1],
    [' 25 ', 25],
    ['10000', 10000],
  ])('accepts %s', (text, expected) => {
    expect(parseQuantity(text)).toBe(expected);
  });

  test.each(['', '0', '-1', '1.5', '1e3', 'abc', '10001', '123456'])('rejects "%s"', (text) => {
    expect(parseQuantity(text)).toBeNull();
  });
});

describe('validateOrder', () => {
  const line = (key, productId, quantity = '1') => ({ key, productId, quantity });

  test('accepts a valid order and returns numeric ids', () => {
    const { values, errors } = validateOrder({ customerId: '3', lines: [line(1, '5', '2'), line(2, '6')] });
    expect(errors).toEqual({ lines: {} });
    expect(values).toEqual({
      customerId: 3,
      items: [
        { productId: 5, quantity: 2 },
        { productId: 6, quantity: 1 },
      ],
    });
  });

  test('requires a customer, a product and a valid quantity', () => {
    const { values, errors } = validateOrder({ customerId: '', lines: [line(1, '', '0')] });
    expect(values).toBeNull();
    expect(errors.customer).toBeTruthy();
    expect(errors.lines[1].product).toBeTruthy();
    expect(errors.lines[1].quantity).toBeTruthy();
  });

  test('rejects duplicate products and an empty order', () => {
    const dup = validateOrder({ customerId: '3', lines: [line(1, '5'), line(2, '5')] });
    expect(dup.values).toBeNull();
    expect(dup.errors.lines[2].product).toMatch(/already/);
    expect(validateOrder({ customerId: '3', lines: [] }).errors.form).toBeTruthy();
  });
});

test('only valid next actions are offered', () => {
  expect(ACTIONS_BY_STATUS.PENDING).toEqual(['confirm', 'cancel']);
  expect(ACTIONS_BY_STATUS.CONFIRMED).toEqual(['ship', 'cancel']);
  expect(ACTIONS_BY_STATUS.SHIPPED).toEqual(['deliver']);
  expect(ACTIONS_BY_STATUS.DELIVERED).toEqual([]);
  expect(ACTIONS_BY_STATUS.CANCELLED).toEqual([]);
});
