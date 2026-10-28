const { toCents, formatCents, lineCents, MAX_TOTAL_CENTS } = require('../../src/utils/money');

describe('toCents', () => {
  test.each([
    ['19.99', 1999],
    ['0.00', 0],
    ['0.1', 10],
    ['5', 500],
    ['5.5', 550],
    ['99999999.99', 9999999999],
  ])('%s -> %i', (text, cents) => {
    expect(toCents(text)).toBe(cents);
  });

  test.each(['', '-1.00', '1.005', '1,50', 'abc', '1e3', ' 1.00', '1.', '.5', '1234567890123456'])(
    'rejects %j',
    (text) => {
      expect(() => toCents(text)).toThrow();
    }
  );
});

describe('formatCents', () => {
  test.each([
    [1999, '19.99'],
    [0, '0.00'],
    [5, '0.05'],
    [100, '1.00'],
    [MAX_TOTAL_CENTS, '9999999999.99'],
  ])('%i -> %s', (cents, text) => {
    expect(formatCents(cents)).toBe(text);
  });

  test.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects %s', (cents) => {
    expect(() => formatCents(cents)).toThrow();
  });

  test('round-trips with toCents', () => {
    for (const text of ['0.01', '0.10', '123.45', '9999999999.99']) {
      expect(formatCents(toCents(text))).toBe(text);
    }
  });
});

describe('lineCents', () => {
  test('multiplies exactly', () => {
    expect(lineCents('19.99', 3)).toBe(5997);
    expect(lineCents('0.10', 3)).toBe(30); // floating point would give 0.30000000000000004
    expect(lineCents('0.00', 5)).toBe(0);
  });

  test('rejects a bad quantity', () => {
    expect(() => lineCents('1.00', 1.5)).toThrow();
    expect(() => lineCents('1.00', -1)).toThrow();
  });
});

describe('summing lines in cents', () => {
  test('0.1 + 0.2 is exactly 0.30', () => {
    expect(formatCents(toCents('0.10') + toCents('0.20'))).toBe('0.30');
  });

  test('many small lines add up without drift', () => {
    let total = 0;
    for (let i = 0; i < 50; i += 1) total += lineCents('0.07', 3);
    expect(formatCents(total)).toBe('10.50');
  });
});
