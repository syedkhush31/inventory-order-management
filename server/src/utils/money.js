// Exact money arithmetic. Amounts are handled as whole cents (integers), never as floating-point numbers,
// so 0.1 + 0.2 style errors cannot happen. MySQL DECIMAL values arrive as strings such as "19.99".

// Largest value of orders.total_amount, DECIMAL(12,2): 9999999999.99, i.e. this many cents.
const MAX_TOTAL_CENTS = 999999999999;

// "19.99" -> 1999. Accepts only plain non-negative decimals with at most two decimal places.
function toCents(amount) {
  const text = String(amount);
  const match = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new Error('Not a valid money amount');
  }
  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) {
    throw new Error('Money amount is too large');
  }
  return cents;
}

// 1999 -> "19.99". Always two decimal places.
function formatCents(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error('Cents must be a non-negative safe integer');
  }
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, '0');
  return `${whole}.${fraction}`;
}

// Price (string) times a whole quantity -> cents. Throws if the result is not a safe integer.
function lineCents(unitPrice, quantity) {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error('Quantity must be a non-negative whole number');
  }
  const cents = toCents(unitPrice) * quantity;
  if (!Number.isSafeInteger(cents)) {
    throw new Error('Money amount is too large');
  }
  return cents;
}

module.exports = { toCents, formatCents, lineCents, MAX_TOTAL_CENTS };
