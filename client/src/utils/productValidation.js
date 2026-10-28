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

// ---- Stock correction form ----
export const MAX_STOCK_DELTA = 2147483647;
export const MAX_REASON_LENGTH = 255;
export const STOCK_FIELD_ORDER = ['delta', 'reason'];

const SIGNED_WHOLE_NUMBER_PATTERN = /^[+-]?\d+$/;

// The stock after applying a typed change, or null while the text is not a usable whole number.
// Shown as a live preview; validateStockAdjustment() below is what actually blocks a bad change.
export function previewStock(deltaText, currentStock) {
  const text = deltaText.trim();
  if (!SIGNED_WHOLE_NUMBER_PATTERN.test(text)) return null;
  const delta = Number(text);
  if (!Number.isSafeInteger(delta)) return null;
  return currentStock + delta;
}

// input: { delta, reason } as typed. currentStock: the number on hand now.
// Returns { values, errors }; values is { delta, reason } with delta as a whole number, or null on errors.
// The server checks all of this again, and also against the real stock at the moment of saving.
export function validateStockAdjustment(input, currentStock) {
  const deltaText = input.delta.trim();
  const reason = input.reason.trim();
  const errors = {};
  let delta = 0;

  if (deltaText === '') {
    errors.delta = 'Enter the change in stock, such as 5 or -3.';
  } else if (!SIGNED_WHOLE_NUMBER_PATTERN.test(deltaText)) {
    errors.delta = 'Enter a whole number such as 5 or -3.';
  } else {
    delta = Number(deltaText);
    if (!Number.isSafeInteger(delta) || Math.abs(delta) > MAX_STOCK_DELTA) {
      errors.delta = 'That change is too large.';
    } else if (delta === 0) {
      errors.delta = 'The change cannot be 0.';
    } else if (currentStock + delta < 0) {
      errors.delta = `Stock cannot go below 0. Only ${currentStock.toLocaleString('en-US')} on hand.`;
    } else if (currentStock + delta > MAX_STOCK_QUANTITY) {
      errors.delta = `Stock cannot be more than ${MAX_STOCK_QUANTITY.toLocaleString('en-US')}.`;
    }
  }

  if (reason === '') {
    errors.reason = 'Enter a reason for the correction.';
  } else if (reason.length > MAX_REASON_LENGTH) {
    errors.reason = `The reason must be ${MAX_REASON_LENGTH} characters or fewer.`;
  } else if (CONTROL_CHARACTERS.test(reason)) {
    errors.reason = 'The reason cannot contain control characters.';
  }

  if (Object.keys(errors).length > 0) {
    return { values: null, errors };
  }
  return { values: { delta, reason }, errors };
}
