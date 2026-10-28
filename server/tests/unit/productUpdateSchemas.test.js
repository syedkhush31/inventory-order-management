// Validation rules for editing a product and for the :id in the URL. Pure schema tests: no database, no HTTP.
const { updateProductSchema, productIdSchema } = require('../../src/validation/productSchemas');

const fieldsOf = (result) => [...new Set(result.error.issues.map((i) => (i.keys ? i.keys.join(',') : i.path.join('.'))))];

describe('updateProductSchema', () => {
  test('accepts any single field and keeps only what was sent', () => {
    expect(updateProductSchema.safeParse({ name: 'New name' }).data).toEqual({ name: 'New name' });
    expect(updateProductSchema.safeParse({ sku: 'A-1' }).data).toEqual({ sku: 'A-1' });
    expect(updateProductSchema.safeParse({ price: '5' }).data).toEqual({ price: '5' });
  });

  test('accepts all three fields, trimming sku and name and keeping the price text exact', () => {
    const result = updateProductSchema.safeParse({ sku: ' ab-1 ', name: '  Mouse ', price: '0.10' });
    expect(result.data).toEqual({ sku: 'ab-1', name: 'Mouse', price: '0.10' });
  });

  test('rejects an empty body', () => {
    const result = updateProductSchema.safeParse({});
    expect(result.success).toBe(false);
    expect(fieldsOf(result)).toEqual(['body']);
  });

  test.each([
    ['stockQuantity', { stockQuantity: 5 }],
    ['isActive', { isActive: false }],
    ['id', { id: 3 }],
    ['createdAt', { createdAt: '2026-01-01' }],
  ])('rejects %s (it has its own route or cannot be set)', (key, body) => {
    const result = updateProductSchema.safeParse({ name: 'ok', ...body });
    expect(result.success).toBe(false);
    expect(fieldsOf(result)).toEqual([key]);
  });

  test.each([
    ['empty sku', { sku: '' }, 'sku'],
    ['sku with a space', { sku: 'A B' }, 'sku'],
    ['sku of 65 characters', { sku: 'X'.repeat(65) }, 'sku'],
    ['blank name', { name: '   ' }, 'name'],
    ['name with a control character', { name: 'a\u0000b' }, 'name'],
    ['name of 256 characters', { name: 'n'.repeat(256) }, 'name'],
    ['numeric price', { price: 19.99 }, 'price'],
    ['three decimals', { price: '1.999' }, 'price'],
    ['negative price', { price: '-1' }, 'price'],
    ['exponent price', { price: '1e3' }, 'price'],
    ['too many digits', { price: '123456789' }, 'price'],
  ])('rejects %s', (_label, body, field) => {
    const result = updateProductSchema.safeParse(body);
    expect(result.success).toBe(false);
    expect(fieldsOf(result)).toEqual([field]);
  });

  test('an explicit undefined does not count as a change', () => {
    expect(updateProductSchema.safeParse({ name: undefined }).success).toBe(false);
  });

  test('rejects non-object bodies', () => {
    expect(updateProductSchema.safeParse(null).success).toBe(false);
    expect(updateProductSchema.safeParse('x').success).toBe(false);
    expect(updateProductSchema.safeParse([]).success).toBe(false);
  });
});

describe('productIdSchema', () => {
  test.each(['1', '42', '999999999999999'])('accepts %s as a number', (value) => {
    expect(productIdSchema.parse(value)).toBe(Number(value));
  });

  test.each(['0', '-1', '01', '1.5', '1e3', ' 1', '1 ', 'abc', '', '1000000000000000', '9007199254740993'])(
    'rejects %p',
    (value) => {
      expect(productIdSchema.safeParse(value).success).toBe(false);
    }
  );
});
