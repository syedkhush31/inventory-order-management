// Checks the "Add product" form before anything is sent. The rules match the server's rules exactly;
// the server still validates everything again, so these checks are only for fast, friendly feedback.
// Money stays text: the price is never converted to a number.

export const MAX_SKU_LENGTH = 64;
export const MAX_NAME_LENGTH = 255;
export const MAX_STOCK_QUANTITY = 4294967295;

const SKU_PATTERN = /^[A-Za-z0-9\-_./]+$/;
const PRICE_PATTERN = /^\d{1,8}(\.\d{1,2})?$/;
const WHOLE_NUMBER_PATTERN = /^\d+$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

// The order fields appear on screen, used to focus the first problem.
export const FIELD_ORDER = ['sku', 'name', 'price', 'stock'];

// input: { sku, name, price, stock } as typed (all strings).
// Returns { values, errors }. When there are errors, values is null.
// values is ready to send: { sku, name, price, stockQuantity } with stockQuantity as a whole number.
export function validateProductForm(input) {
  const sku = input.sku.trim();
  const name = input.name.trim();
  const price = input.price.trim();
  const stock = input.stock.trim();
  const errors = {};

  if (sku === '') {
    errors.sku = 'Enter a SKU.';
  } else if (sku.length > MAX_SKU_LENGTH) {
    errors.sku = `SKU must be ${MAX_SKU_LENGTH} characters or fewer.`;
  } else if (/\s/.test(sku)) {
    errors.sku = 'SKU cannot contain spaces.';
  } else if (!SKU_PATTERN.test(sku)) {
    errors.sku = 'Use only letters, digits, hyphens, underscores, periods and slashes.';
  }

  if (name === '') {
    errors.name = 'Enter a product name.';
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.name = `Product name must be ${MAX_NAME_LENGTH} characters or fewer.`;
  } else if (CONTROL_CHARACTERS.test(name)) {
    errors.name = 'Product name cannot contain control characters.';
  }

  if (price === '') {
    errors.price = 'Enter a price.';
  } else if (!PRICE_PATTERN.test(price)) {
    errors.price = 'Enter a price such as 19.99: digits only, up to 8 before the decimal point and 2 after.';
  }

  let stockQuantity = 0; // a blank stock field means 0
  if (stock !== '') {
    if (!WHOLE_NUMBER_PATTERN.test(stock)) {
      errors.stock = 'Enter a whole number, 0 or more.';
    } else if (stock.length > 10 || Number(stock) > MAX_STOCK_QUANTITY) {
      errors.stock = `Stock cannot be more than ${MAX_STOCK_QUANTITY.toLocaleString('en-US')}.`;
    } else {
      stockQuantity = Number(stock);
    }
  }

  if (Object.keys(errors).length > 0) {
    return { values: null, errors };
  }
  return { values: { sku, name, price, stockQuantity }, errors };
}
