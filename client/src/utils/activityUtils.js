// Display rules for the Activity page: titles, colours, filters and date handling.
// Everything shown comes from the server's stored records. Nothing here creates or guesses an event.
import { STATUS_LABELS } from './orderUtils.js';

// The groups offered by the type filter. The values are what GET /api/activity accepts.
export const TYPE_OPTIONS = [
  { value: 'all', label: 'All activity' },
  { value: 'order', label: 'Orders' },
  { value: 'stock', label: 'Stock adjustments' },
  { value: 'product', label: 'Products' },
  { value: 'customer', label: 'Customers' },
  { value: 'account', label: 'Account' },
  { value: 'settings', label: 'Settings' },
];

// Every event type the server can send, with its title and badge colour (success, danger, neutral, warning, info).
export const EVENT_INFO = {
  ORDER_CREATED: { title: 'Order created', tone: 'warning', group: 'order' },
  ORDER_CONFIRMED: { title: 'Order confirmed', tone: 'info', group: 'order' },
  ORDER_SHIPPED: { title: 'Order shipped', tone: 'info', group: 'order' },
  ORDER_DELIVERED: { title: 'Order delivered', tone: 'success', group: 'order' },
  ORDER_CANCELLED: { title: 'Order cancelled', tone: 'danger', group: 'order' },
  STOCK_ADJUSTED: { title: 'Stock adjusted', tone: 'neutral', group: 'stock' },
  PRODUCT_CREATED: { title: 'Product created', tone: 'success', group: 'product' },
  PRODUCT_UPDATED: { title: 'Product updated', tone: 'info', group: 'product' },
  PRODUCT_ACTIVATED: { title: 'Product reactivated', tone: 'success', group: 'product' },
  PRODUCT_DEACTIVATED: { title: 'Product deactivated', tone: 'neutral', group: 'product' },
  CUSTOMER_CREATED: { title: 'Customer created', tone: 'success', group: 'customer' },
  CUSTOMER_UPDATED: { title: 'Customer updated', tone: 'info', group: 'customer' },
  CUSTOMER_ACTIVATED: { title: 'Customer reactivated', tone: 'success', group: 'customer' },
  CUSTOMER_DEACTIVATED: { title: 'Customer deactivated', tone: 'neutral', group: 'customer' },
  ACCOUNT_PROFILE_UPDATED: { title: 'Profile updated', tone: 'info', group: 'account' },
  ACCOUNT_PASSWORD_CHANGED: { title: 'Password changed', tone: 'info', group: 'account' },
  SETTINGS_UPDATED: { title: 'Settings updated', tone: 'info', group: 'settings' },
};

// An event type this page does not know is still shown, with a neutral label, never hidden.
export function eventInfo(type) {
  return EVENT_INFO[type] ?? { title: String(type).replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()), tone: 'neutral', group: 'other' };
}

export const FIELD_LABELS = {
  sku: 'SKU',
  name: 'Name',
  price: 'Price',
  email: 'Email',
  phone: 'Phone',
  address: 'Address',
  displayName: 'Display name',
};

export function fieldLabel(field) {
  return FIELD_LABELS[field] ?? field;
}

// "Sam" when the administrator has a display name, otherwise the sign-in email.
export function actorName(actor) {
  if (!actor) return 'Unknown administrator';
  return actor.displayName || actor.email;
}

const NO_SUMMARY = 'Details not available';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);

// A short, plain sentence for the list row. The full facts are in the details panel.
// It never throws: an event that arrives without its details, its entity or its statuses gets the best sentence the
// remaining facts allow, and "Details not available" when there is nothing at all. It never fills a gap with a guess.
export function summarise(event) {
  if (!isObject(event)) return NO_SUMMARY;
  const details = isObject(event.details) ? event.details : {};
  const label = isObject(event.entity) ? text(event.entity.label) : null;
  const fallback = label ?? NO_SUMMARY;

  switch (event.type) {
    case 'ORDER_CREATED': {
      const customer = text(details.customerName);
      if (!customer) return fallback;
      return `${label ?? 'Order'} for ${customer}`;
    }
    case 'ORDER_CONFIRMED':
    case 'ORDER_SHIPPED':
    case 'ORDER_DELIVERED':
    case 'ORDER_CANCELLED': {
      const from = text(details.fromStatus);
      const to = text(details.toStatus);
      if (from && to) return `${label ?? 'Order'}: ${statusName(from)} → ${statusName(to)}`;
      if (to) return `${label ?? 'Order'}: ${statusName(to)}`;
      return fallback;
    }
    case 'STOCK_ADJUSTED': {
      const delta = details.quantityDelta;
      if (typeof delta !== 'number' || !Number.isFinite(delta)) return fallback;
      return `${label ?? 'Stock'}: ${signed(delta)} units`;
    }
    case 'PRODUCT_UPDATED':
    case 'CUSTOMER_UPDATED':
    case 'ACCOUNT_PROFILE_UPDATED': {
      const fields = Array.isArray(details.changedFields) ? details.changedFields.filter((field) => text(field)) : [];
      return fields.length > 0 ? `${label ?? 'Changed'}: ${fields.map(fieldLabel).join(', ')} changed` : fallback;
    }
    case 'SETTINGS_UPDATED': {
      const { from, to } = details;
      const numbers = [from, to].every((n) => typeof n === 'number' && Number.isFinite(n));
      return numbers ? `Low-stock threshold ${from} → ${to}` : fallback;
    }
    default:
      return fallback;
  }
}

export function statusName(status) {
  return status ? STATUS_LABELS[status] ?? status : '—';
}

// +5 / −3 / 0, with a real minus sign.
export function signed(number) {
  const n = Number(number);
  if (n > 0) return `+${n.toLocaleString('en-US')}`;
  if (n < 0) return `−${Math.abs(n).toLocaleString('en-US')}`;
  return '0';
}

// ---- Dates ----
// The date pickers hold local calendar dates ("2026-11-01"). The server wants UTC instants, with `to` exclusive, so
// the range is [start of the first day, start of the day AFTER the last day) in the browser's time zone.
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function localMidnight(dateText, dayOffset = 0) {
  const match = DATE_PATTERN.exec(dateText);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + dayOffset, 0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Returns { from, to, error }. from / to are ISO strings or undefined; error explains an impossible range.
export function dateRangeToInstants(fromDate, toDate) {
  const start = fromDate ? localMidnight(fromDate) : null;
  const end = toDate ? localMidnight(toDate, 1) : null;
  if ((fromDate && !start) || (toDate && !end)) return { error: 'Enter the dates as day, month and year.' };
  if (start && end && start >= end) return { error: 'The end date must be the same as or after the start date.' };
  return { from: start ? start.toISOString() : undefined, to: end ? end.toISOString() : undefined };
}

// Groups a page of events under local calendar days, keeping the server's order (newest first).
export function groupByDay(events) {
  const groups = [];
  for (const event of events) {
    const date = new Date(event.occurredAt);
    const key = Number.isNaN(date.getTime())
      ? 'unknown'
      : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.events.push(event);
    else groups.push({ key, date: key === 'unknown' ? null : date, events: [event] });
  }
  return groups;
}

// "Today", "Yesterday", or a full date such as "Monday, 27 October 2026".
export function dayHeading(date, now = new Date()) {
  if (!date) return 'Unknown date';
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(date, now)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

// "10:30" style time for a row (the full date is in the day heading).
export function timeOfDay(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
