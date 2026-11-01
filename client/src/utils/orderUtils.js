// Order helpers: status labels, which actions are valid, and money maths in whole cents (never floating point).
// The server is the authority for prices, totals and transitions. Everything here is a convenience for the screen.

export const MAX_ITEMS_PER_ORDER = 50;
export const MAX_QUANTITY_PER_ITEM = 10000;

export const STATUS_LABELS = {
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};

export const STATUS_TONES = {
  PENDING: 'warning',
  CONFIRMED: 'info',
  SHIPPED: 'info',
  DELIVERED: 'success',
  CANCELLED: 'danger',
};

// Mirrors the server's allowed moves. The server still rejects anything else with 409.
export const ACTIONS_BY_STATUS = {
  PENDING: ['confirm', 'cancel'],
  CONFIRMED: ['ship', 'cancel'],
  SHIPPED: ['deliver'],
  DELIVERED: [],
  CANCELLED: [],
};

export const ACTION_LABELS = {
  confirm: 'Confirm order',
  cancel: 'Cancel order',
  ship: 'Mark as shipped',
  deliver: 'Mark as delivered',
};

export const ACTION_PROGRESS = {
  confirm: 'Confirming…',
  cancel: 'Cancelling…',
  ship: 'Marking as shipped…',
  deliver: 'Marking as delivered…',
};

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? status;
}

// "19.99" -> 1999. Returns null for anything that is not a plain money string.
export function priceToCents(value) {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

// 1999 -> "19.99"
export function centsToPrice(cents) {
  const whole = Math.floor(cents / 100);
  return `${whole}.${String(cents % 100).padStart(2, '0')}`;
}

// quantity: the text typed in the box. Returns null unless it is a whole number from 1 to the server's maximum.
export function parseQuantity(text) {
  const trimmed = String(text).trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const quantity = Number(trimmed);
  return quantity >= 1 && quantity <= MAX_QUANTITY_PER_ITEM ? quantity : null;
}

// An estimate for one line, or null while the product or quantity is not usable yet.
export function estimateLineCents(product, quantityText) {
  const quantity = parseQuantity(quantityText);
  const unit = product ? priceToCents(product.price) : null;
  if (quantity === null || unit === null) return null;
  return unit * quantity;
}

// lines: [{ key, productId: '' | string, quantity: string }]
// Returns { values, errors }. values is { customerId, items } when everything is valid, otherwise null.
// errors: { customer?, form?, lines: { [key]: { product?, quantity? } } }
export function validateOrder({ customerId, lines }) {
  const errors = { lines: {} };
  const setLine = (key, field, message) => {
    errors.lines[key] = { ...errors.lines[key], [field]: message };
  };

  if (!customerId) errors.customer = 'Choose a customer.';

  if (lines.length === 0) {
    errors.form = 'Add at least one product.';
  } else if (lines.length > MAX_ITEMS_PER_ORDER) {
    errors.form = `An order can have at most ${MAX_ITEMS_PER_ORDER} products.`;
  }

  const seen = new Set();
  const items = [];
  for (const line of lines) {
    if (!line.productId) {
      setLine(line.key, 'product', 'Choose a product.');
    } else if (seen.has(line.productId)) {
      setLine(line.key, 'product', 'This product is already on the order. Change its quantity instead.');
    } else {
      seen.add(line.productId);
    }

    const quantity = parseQuantity(line.quantity);
    if (quantity === null) {
      setLine(line.key, 'quantity', `Enter a whole number from 1 to ${MAX_QUANTITY_PER_ITEM.toLocaleString('en-US')}.`);
    } else if (line.productId) {
      items.push({ productId: Number(line.productId), quantity });
    }
  }

  const valid = !errors.customer && !errors.form && Object.keys(errors.lines).length === 0;
  return { values: valid ? { customerId: Number(customerId), items } : null, errors };
}
