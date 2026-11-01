import { describe, expect, test } from 'vitest';
import {
  EVENT_INFO,
  TYPE_OPTIONS,
  actorName,
  dateRangeToInstants,
  dayHeading,
  eventInfo,
  fieldLabel,
  groupByDay,
  signed,
  summarise,
} from './activityUtils.js';

// Every type the server's activity endpoint can send: the order events and manual stock, and the 11 audit events.
const SERVER_EVENT_TYPES = [
  'ORDER_CREATED', 'ORDER_CONFIRMED', 'ORDER_SHIPPED', 'ORDER_DELIVERED', 'ORDER_CANCELLED',
  'STOCK_ADJUSTED',
  'PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_ACTIVATED', 'PRODUCT_DEACTIVATED',
  'CUSTOMER_CREATED', 'CUSTOMER_UPDATED', 'CUSTOMER_ACTIVATED', 'CUSTOMER_DEACTIVATED',
  'ACCOUNT_PROFILE_UPDATED', 'ACCOUNT_PASSWORD_CHANGED', 'SETTINGS_UPDATED',
];

describe('event types and filters', () => {
  test('every type the server can send has a title and a colour', () => {
    for (const type of SERVER_EVENT_TYPES) {
      expect(EVENT_INFO[type]).toBeDefined();
      expect(EVENT_INFO[type].title).toBeTruthy();
      expect(['success', 'danger', 'neutral', 'warning', 'info']).toContain(EVENT_INFO[type].tone);
    }
    expect(Object.keys(EVENT_INFO).sort()).toEqual([...SERVER_EVENT_TYPES].sort());
  });

  test('the type filter offers exactly the groups the server accepts', () => {
    expect(TYPE_OPTIONS.map((o) => o.value)).toEqual(['all', 'order', 'stock', 'product', 'customer', 'account', 'settings']);
  });

  test('an unknown type is still shown with a readable title, never hidden', () => {
    expect(eventInfo('SOMETHING_NEW_HAPPENED')).toMatchObject({ title: 'Something new happened', tone: 'neutral' });
  });

  test('field names read as words', () => {
    expect(fieldLabel('sku')).toBe('SKU');
    expect(fieldLabel('displayName')).toBe('Display name');
    expect(fieldLabel('unknownField')).toBe('unknownField');
  });
});

describe('actors and numbers', () => {
  test('the display name wins, otherwise the sign-in email', () => {
    expect(actorName({ id: 1, email: 'admin@example.com', displayName: 'Sam' })).toBe('Sam');
    expect(actorName({ id: 1, email: 'admin@example.com', displayName: null })).toBe('admin@example.com');
    expect(actorName(null)).toBe('Unknown administrator');
  });

  test('stock changes show a plus, or a real minus sign', () => {
    expect(signed(5)).toBe('+5');
    expect(signed(-3)).toBe('−3');
    expect(signed(0)).toBe('0');
    expect(signed(-1200)).toBe('−1,200');
  });
});

describe('summarise', () => {
  const actor = { id: 7, email: 'admin@example.com', displayName: null };
  const make = (type, entity, details) => ({ id: 'x', type, occurredAt: '2026-10-27T12:00:00.000Z', actor, entity, details });

  test('order events show the order and the status change', () => {
    const order = { type: 'order', id: 4, label: 'Order #4' };
    expect(summarise(make('ORDER_CREATED', order, { customerName: 'Ann Lee' }))).toBe('Order #4 for Ann Lee');
    expect(summarise(make('ORDER_CONFIRMED', order, { fromStatus: 'PENDING', toStatus: 'CONFIRMED' }))).toBe('Order #4: Pending → Confirmed');
    expect(summarise(make('ORDER_CANCELLED', order, { fromStatus: 'CONFIRMED', toStatus: 'CANCELLED' }))).toBe('Order #4: Confirmed → Cancelled');
  });

  test('stock, product, customer and settings events', () => {
    expect(summarise(make('STOCK_ADJUSTED', { type: 'product', id: 5, label: 'SKU-1 — Monitor' }, { quantityDelta: -2 }))).toBe('SKU-1 — Monitor: −2 units');
    expect(summarise(make('PRODUCT_UPDATED', { type: 'product', id: 5, label: 'SKU-1 — Monitor' }, { changedFields: ['name', 'price'] }))).toBe('SKU-1 — Monitor: Name, Price changed');
    expect(summarise(make('CUSTOMER_UPDATED', { type: 'customer', id: 9, label: 'Ann Lee' }, { changedFields: ['email'] }))).toBe('Ann Lee: Email changed');
    expect(summarise(make('SETTINGS_UPDATED', { type: 'settings', id: null, label: 'Settings' }, { key: 'low_stock_threshold', from: 5, to: 8 }))).toBe('Low-stock threshold 5 → 8');
    expect(summarise(make('PRODUCT_DEACTIVATED', { type: 'product', id: 5, label: 'SKU-1 — Monitor' }, null))).toBe('SKU-1 — Monitor');
  });

  test('an event whose details were withheld by the server still has a summary', () => {
    expect(summarise(make('CUSTOMER_UPDATED', { type: 'customer', id: 9, label: 'Customer #9' }, null))).toBe('Customer #9');
    expect(summarise(make('SETTINGS_UPDATED', { type: 'settings', id: null, label: 'Settings' }, null))).toBe('Settings');
  });
});

describe('date range', () => {
  test('no dates means no limits', () => {
    expect(dateRangeToInstants('', '')).toEqual({ from: undefined, to: undefined });
  });

  test('from is the start of that local day and to is the start of the day AFTER the end date (exclusive)', () => {
    const range = dateRangeToInstants('2026-11-01', '2026-11-03');
    expect(range.from).toBe(new Date(2026, 10, 1, 0, 0, 0, 0).toISOString());
    expect(range.to).toBe(new Date(2026, 10, 4, 0, 0, 0, 0).toISOString());
    expect(range.error).toBeUndefined();
  });

  test('a single day covers exactly that day', () => {
    const range = dateRangeToInstants('2026-11-01', '2026-11-01');
    expect(new Date(range.to) - new Date(range.from)).toBeGreaterThanOrEqual(23 * 3600 * 1000);
    expect(new Date(range.to) - new Date(range.from)).toBeLessThanOrEqual(25 * 3600 * 1000);
  });

  test('the end of a month and year rolls over correctly', () => {
    expect(dateRangeToInstants('', '2026-12-31').to).toBe(new Date(2027, 0, 1).toISOString());
    expect(dateRangeToInstants('', '2026-02-28').to).toBe(new Date(2026, 2, 1).toISOString());
  });

  test('only one end is fine', () => {
    expect(dateRangeToInstants('2026-11-01', '').to).toBeUndefined();
    expect(dateRangeToInstants('', '2026-11-01').from).toBeUndefined();
  });

  test('an end before the start, or an unreadable date, gives an error and no instants', () => {
    expect(dateRangeToInstants('2026-11-05', '2026-11-01')).toEqual({ error: 'The end date must be the same as or after the start date.' });
    expect(dateRangeToInstants('11/01/2026', '')).toEqual({ error: 'Enter the dates as day, month and year.' });
    expect(dateRangeToInstants('', 'yesterday')).toEqual({ error: 'Enter the dates as day, month and year.' });
  });
});

describe('grouping by day', () => {
  const at = (id, iso) => ({ id, occurredAt: iso });

  test('keeps the server order and starts a new group when the local day changes', () => {
    const events = [at('a', '2026-10-27T12:00:00.000Z'), at('b', '2026-10-27T12:05:00.000Z'), at('c', '2026-10-26T12:00:00.000Z')];
    const groups = groupByDay(events);
    expect(groups.map((g) => g.events.map((e) => e.id))).toEqual([['a', 'b'], ['c']]);
  });

  test('the same day that comes back later (an out-of-order page) is a separate group, not a merge', () => {
    const groups = groupByDay([at('a', '2026-10-27T12:00:00.000Z'), at('b', '2026-10-26T12:00:00.000Z'), at('c', '2026-10-27T12:00:00.000Z')]);
    expect(groups).toHaveLength(3);
  });

  test('an unreadable time is kept, under an unknown date', () => {
    const groups = groupByDay([at('a', 'not a date')]);
    expect(groups).toHaveLength(1);
    expect(dayHeading(groups[0].date)).toBe('Unknown date');
  });

  test('headings say Today and Yesterday, otherwise the full date', () => {
    const now = new Date(2026, 10, 1, 15, 0, 0);
    expect(dayHeading(new Date(2026, 10, 1, 9, 0, 0), now)).toBe('Today');
    expect(dayHeading(new Date(2026, 9, 31, 23, 59, 0), now)).toBe('Yesterday');
    expect(dayHeading(new Date(2026, 9, 27, 9, 0, 0), now)).toMatch(/2026/);
    expect(dayHeading(new Date(2026, 9, 27, 9, 0, 0), now)).toMatch(/27/);
  });
});

describe('summarise with missing or malformed data never throws', () => {
  const actor = { id: 7, email: 'admin@example.com', displayName: null };
  const order = { type: 'order', id: 4, label: 'Order #4' };
  const product = { type: 'product', id: 5, label: 'SKU-1004 — Monitor' };
  const make = (type, entity, details) => ({ id: 'x', type, occurredAt: '2026-10-27T12:00:00.000Z', actor, entity, details });

  test('an order event with no details falls back to the order label, with nothing invented', () => {
    expect(summarise(make('ORDER_CREATED', order, null))).toBe('Order #4');
    expect(summarise(make('ORDER_CREATED', order, undefined))).toBe('Order #4');
    expect(summarise(make('ORDER_CREATED', order, {}))).toBe('Order #4');
    for (const type of ['ORDER_CONFIRMED', 'ORDER_SHIPPED', 'ORDER_DELIVERED', 'ORDER_CANCELLED']) {
      expect(summarise(make(type, order, null))).toBe('Order #4');
      expect(summarise(make(type, order, {}))).toBe('Order #4');
    }
  });

  test('a status event with only one status says only what is known', () => {
    expect(summarise(make('ORDER_CONFIRMED', order, { toStatus: 'CONFIRMED' }))).toBe('Order #4: Confirmed');
    expect(summarise(make('ORDER_CONFIRMED', order, { fromStatus: 'PENDING' }))).toBe('Order #4');
    expect(summarise(make('ORDER_SHIPPED', order, { fromStatus: null, toStatus: 'SHIPPED' }))).toBe('Order #4: Shipped');
    expect(summarise(make('ORDER_SHIPPED', order, { fromStatus: '', toStatus: '   ' }))).toBe('Order #4');
  });

  test('an order created without a customer name does not print "undefined" or "null"', () => {
    for (const details of [null, {}, { customerName: null }, { customerName: '' }, { customerName: '  ' }, { customerName: 7 }]) {
      const out = summarise(make('ORDER_CREATED', order, details));
      expect(out).toBe('Order #4');
      expect(out).not.toMatch(/undefined|null|NaN/);
    }
    expect(summarise(make('ORDER_CREATED', null, { customerName: 'Ann Lee' }))).toBe('Order for Ann Lee');
  });

  test('a stock event with no usable quantity falls back to the product label', () => {
    expect(summarise(make('STOCK_ADJUSTED', product, null))).toBe('SKU-1004 — Monitor');
    expect(summarise(make('STOCK_ADJUSTED', product, {}))).toBe('SKU-1004 — Monitor');
    for (const quantityDelta of [null, undefined, 'abc', '5', NaN, Infinity, {}, []]) {
      const out = summarise(make('STOCK_ADJUSTED', product, { quantityDelta }));
      expect(out).toBe('SKU-1004 — Monitor');
      expect(out).not.toMatch(/NaN|undefined|null/);
    }
    expect(summarise(make('STOCK_ADJUSTED', product, { quantityDelta: 0 }))).toBe('SKU-1004 — Monitor: 0 units');
    expect(summarise(make('STOCK_ADJUSTED', product, { quantityDelta: -2 }))).toBe('SKU-1004 — Monitor: −2 units');
  });

  test('with no entity label at all the summary says that details are not available', () => {
    for (const entity of [null, undefined, {}, { label: '' }, { label: 7 }, 'Order #4', []]) {
      expect(summarise(make('ORDER_CONFIRMED', entity, null))).toBe('Details not available');
      expect(summarise(make('STOCK_ADJUSTED', entity, null))).toBe('Details not available');
      expect(summarise(make('PRODUCT_DEACTIVATED', entity, null))).toBe('Details not available');
    }
  });

  test('an event that is not an object at all gets the same plain answer', () => {
    for (const bad of [null, undefined, 'text', 42, [], true]) expect(summarise(bad)).toBe('Details not available');
  });

  test('changed-field lists that are not lists, or hold non-text, do not crash', () => {
    expect(summarise(make('PRODUCT_UPDATED', product, { changedFields: 'name' }))).toBe('SKU-1004 — Monitor');
    expect(summarise(make('PRODUCT_UPDATED', product, { changedFields: [] }))).toBe('SKU-1004 — Monitor');
    expect(summarise(make('PRODUCT_UPDATED', product, { changedFields: [null, 5, 'price'] }))).toBe('SKU-1004 — Monitor: Price changed');
    expect(summarise(make('CUSTOMER_UPDATED', { type: 'customer', id: 9, label: 'Ann Lee' }, { changedFields: { 0: 'email' } }))).toBe('Ann Lee');
  });

  test('a settings event with missing or non-numeric values falls back', () => {
    const settings = { type: 'settings', id: null, label: 'Settings' };
    expect(summarise(make('SETTINGS_UPDATED', settings, null))).toBe('Settings');
    expect(summarise(make('SETTINGS_UPDATED', settings, { from: 5 }))).toBe('Settings');
    expect(summarise(make('SETTINGS_UPDATED', settings, { from: '5', to: '8' }))).toBe('Settings');
    expect(summarise(make('SETTINGS_UPDATED', settings, { from: 5, to: 8 }))).toBe('Low-stock threshold 5 → 8');
  });

  test('every event type with every kind of broken details and entity returns a non-empty string and never throws', () => {
    const detailsVariants = [undefined, null, {}, [], 'text', 42, true, { fromStatus: null }, { toStatus: 7 }, { changedFields: 'x' }, { quantityDelta: 'x' }, { customerName: {} }, { from: {}, to: [] }];
    const entityVariants = [undefined, null, {}, { label: null }, { label: 5 }, order, product];
    for (const type of [...Object.keys(EVENT_INFO), 'SOMETHING_NEW', undefined, 7, null]) {
      for (const details of detailsVariants) {
        for (const entity of entityVariants) {
          let out;
          expect(() => { out = summarise({ id: 'x', type, occurredAt: 'now', actor, entity, details }); }).not.toThrow();
          expect(typeof out).toBe('string');
          expect(out.trim()).not.toBe('');
          expect(out).not.toMatch(/undefined|NaN|\[object/);
        }
      }
    }
  });

  test('complete events still read exactly as before', () => {
    expect(summarise(make('ORDER_CREATED', order, { customerName: 'Ann Lee' }))).toBe('Order #4 for Ann Lee');
    expect(summarise(make('ORDER_CANCELLED', order, { fromStatus: 'CONFIRMED', toStatus: 'CANCELLED' }))).toBe('Order #4: Confirmed → Cancelled');
  });
});
