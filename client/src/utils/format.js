// Display helpers. Money is handled as text, never as a floating-point number.

// "1234.5" -> "1,234.50". The API sends DECIMAL(10,2) values as strings such as "19.99".
// No currency symbol is added because the database does not store a currency.
export function formatPrice(value) {
  const [whole = '0', fraction = ''] = String(value).split('.');
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${withCommas}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

export function formatQuantity(value) {
  return Number(value).toLocaleString('en-US');
}

export function formatDateTime(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
