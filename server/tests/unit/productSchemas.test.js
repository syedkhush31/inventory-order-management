// Validation rules for creating a product. Pure schema tests: no database, no HTTP.
const { createProductSchema, MAX_STOCK_QUANTITY } = require('../../src/validation/productSchemas');

const valid = { sku: 'SKU-1001', name: 'Wireless Mouse', price: '19.99', stockQuantity: 5 };
const parse = (overrides) => createProductSchema.safeParse({ ...valid, ...overrides });
const fieldsOf = (result) => [...new Set(result.error.issues.map((i) => (i.keys ? i.keys.join(',') : i.path.join('.'))))];

describe('valid input', () => {
  test('is accepted unchanged', () => {
    const result = parse({});
    expect(result.success).toBe(true);
    expect(result.data).toEqual(valid);
  });

  test('stock defaults to 0 when omitted or an empty string', () => {
    const { stockQuantity, ...withoutStock } = valid;
    expect(createProductSchema.safeParse(withoutStock).data.stockQuantity).toBe(0);
    expect(parse({ stockQuantity: '' }).data.stockQuantity).toBe(0);
  });
});

describe('sku', () => {
  test('is trimmed and keeps its letter case', () => {
    expect(parse({ sku: '  AbC-1  ' }).data.sku).toBe('AbC-1');
  });

  test.each(['A', 'a-b_c.d/e', 'X'.repeat(64), '0123456789'])('accepts %s', (sku) => {
    expect(parse({ sku }).success).toBe(true);
  });

  test.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['65 characters', 'X'.repeat(65)],
    ['inner space', 'AB 12'],
    ['inner tab', 'AB\t12'],
    ['unsupported punctuation', 'AB#12'],
    ['percent', 'AB%12'],
    ['quote', "AB'12"],
    ['backslash', 'AB\\12'],
    ['non-ASCII letter', 'CAFÉ-1'],
    ['emoji', 'AB-😀'],
    ['newline', 'AB\n12'],
    ['null byte', 'AB\u000012'],
  ])('rejects %s', (_label, sku) => {
    const result = parse({ sku });
    expect(result.success).toBe(false);
    expect(fieldsOf(result)).toEqual(['sku']);
  });

  test('rejects non-strings and missing values', () => {
    expect(parse({ sku: 123 }).success).toBe(false);
    expect(parse({ sku: null }).success).toBe(false);
    expect(parse({ sku: undefined }).success).toBe(false);
  });
});

describe('name', () => {
  test('is trimmed and may contain ordinary punctuation and non-ASCII text', () => {
    expect(parse({ name: '  27-inch “Monitor” — Café  ' }).data.name).toBe('27-inch “Monitor” — Café');
  });

  test('accepts 1 and 255 characters', () => {
    expect(parse({ name: 'x' }).success).toBe(true);
    expect(parse({ name: 'x'.repeat(255) }).success).toBe(true);
  });

  test.each([
    ['empty', ''],
    ['only spaces', '    '],
    ['256 characters', 'x'.repeat(256)],
    ['newline inside', 'Line1\nLine2'],
    ['tab inside', 'Col1\tCol2'],
    ['null byte', 'Bad\u0000Name'],
    ['escape character', 'Bad\u001bName'],
    ['DEL character', 'Bad\u007fName'],
    ['C1 control character', 'Bad\u0085Name'],
    ['a number', 42],
  ])('rejects %s', (_label, name) => {
    const result = parse({ name });
    expect(result.success).toBe(false);
    expect(fieldsOf(result)).toEqual(['name']);
  });
});

describe('price', () => {
  test.each(['0', '0.00', '0.1', '7', '19.99', '19.9', '99999999', '99999999.99', '00012.50'])('accepts "%s"', (price) => {
    const result = parse({ price });
    expect(result.success).toBe(true);
    expect(result.data.price).toBe(price); // passed through exactly as text, never converted
  });

  test.each([
    ['empty', ''],
    ['negative', '-1'],
    ['negative decimal', '-0.01'],
    ['plus sign', '+5'],
    ['three decimals', '1.001'],
    ['trailing dot', '5.'],
    ['leading dot', '.5'],
    ['nine integer digits', '100000000'],
    ['nine digits with decimals', '100000000.00'],
    ['exponent', '1e3'],
    ['exponent with sign', '1.5E+2'],
    ['comma decimal', '19,99'],
    ['thousands comma', '1,000.00'],
    ['currency symbol', '$19.99'],
    ['inner space', '19 99'],
    ['leading space', ' 19.99'],
    ['trailing space', '19.99 '],
    ['words', 'free'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
    ['hex', '0x10'],
    ['a JSON number', 19.99],
    ['a JSON integer', 20],
    ['null', null],
    ['missing', undefined],
  ])('rejects %s', (_label, price) => {
    const result = parse({ price });
    expect(result.success).toBe(false);
    expect(fieldsOf(result)).toEqual(['price']);
  });
});

describe('stockQuantity', () => {
  test.each([0, 1, 120, 1_000_000, MAX_STOCK_QUANTITY])('accepts %s', (stockQuantity) => {
    expect(parse({ stockQuantity }).data.stockQuantity).toBe(stockQuantity);
  });

  test('the maximum is the INT UNSIGNED limit', () => {
    expect(MAX_STOCK_QUANTITY).toBe(4294967295);
  });

  test.each([
    ['negative', -1],
    ['one over the maximum', MAX_STOCK_QUANTITY + 1],
    ['a decimal', 1.5],
    ['a numeric string', '12'],
    ['text', 'many'],
    ['null', null],
    ['Infinity as text', 'Infinity'],
    ['a boolean', true],
    ['an array', [1]],
  ])('rejects %s', (_label, stockQuantity) => {
    const result = parse({ stockQuantity });
    expect(result.success).toBe(false);
    expect(fieldsOf(result)).toEqual(['stockQuantity']);
  });
});

describe('unexpected properties', () => {
  test.each(['id', 'isActive', 'is_active', 'createdAt', 'updatedAt', 'stock_quantity', 'admin', '__proto__x'])(
    'rejects an extra "%s" property',
    (key) => {
      const result = createProductSchema.safeParse({ ...valid, [key]: 1 });
      expect(result.success).toBe(false);
      expect(result.error.issues[0].code).toBe('unrecognized_keys');
      expect(result.error.issues[0].keys).toContain(key);
    }
  );

  test('rejects non-object bodies', () => {
    for (const body of [undefined, null, 'text', 42, [], [valid]]) {
      expect(createProductSchema.safeParse(body).success).toBe(false);
    }
  });
});
