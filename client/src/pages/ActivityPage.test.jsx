// The Activity page with a fake fetch. Nothing here talks to a real server or database, so these tests prove how the
// page behaves with the answers the API is documented to give; they do not prove the live queries work.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ActivityPage from './ActivityPage.jsx';

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const ADMIN = { id: 7, email: 'admin@example.com', displayName: null };
const DAY1 = '2026-10-27T12:00:00.000Z';
const DAY2 = '2026-10-26T12:00:00.000Z';

const orderEvent = (n, type, extra = {}, when = DAY1) => ({
  id: `order-${n}`,
  type,
  occurredAt: when,
  actor: ADMIN,
  entity: { type: 'order', id: 4, label: 'Order #4' },
  details: { fromStatus: 'PENDING', toStatus: 'CONFIRMED', customerName: 'Ann Lee', totalAmount: '31.50', stockMovements: [], ...extra },
});
const stockEvent = (n, when = DAY1) => ({
  id: `stock-${n}`,
  type: 'STOCK_ADJUSTED',
  occurredAt: when,
  actor: { ...ADMIN, displayName: 'Sam' },
  entity: { type: 'product', id: 5, label: 'SKU-1004 — 27-inch Monitor' },
  details: { productId: 5, sku: 'SKU-1004', productName: '27-inch Monitor', quantityDelta: 5, reason: 'Recount after delivery' },
});
const auditEvent = (n, type, entity, details, when = DAY1) => ({ id: `audit-${n}`, type, occurredAt: when, actor: ADMIN, entity, details });

let events;
let total;
let failWith;

beforeEach(() => {
  events = [];
  total = null;
  failWith = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      if (failWith) return failWith();
      const params = new URL(String(url), 'http://x').searchParams;
      const size = Number(params.get('pageSize'));
      const count = total ?? events.length;
      return reply({ items: events, page: Number(params.get('page')), pageSize: size, total: count, totalPages: Math.ceil(count / size) });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const urls = () => fetch.mock.calls.map(([url]) => String(url));
const lastUrl = () => urls().at(-1);
const params = () => new URL(lastUrl(), 'http://x').searchParams;

async function renderLoaded(props = {}) {
  const onNavigate = vi.fn();
  render(<ActivityPage debounceMs={5} onNavigate={onNavigate} {...props} />);
  await waitFor(() => expect(screen.queryByText('Loading activity…')).not.toBeInTheDocument());
  return onNavigate;
}

describe('the list', () => {
  test('asks for the newest activity with the defaults', async () => {
    events = [orderEvent(1, 'ORDER_CREATED', { fromStatus: null, toStatus: 'PENDING' })];
    await renderLoaded();
    expect(urls()[0]).toBe('/api/activity?type=all&page=1&pageSize=25');
  });

  test('shows each event with its title, what it is about, the time and who did it', async () => {
    events = [orderEvent(2, 'ORDER_CONFIRMED'), stockEvent(1)];
    await renderLoaded();
    const items = screen.getAllByRole('listitem').filter((li) => li.classList.contains('activity-item'));
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText('Order confirmed')).toBeInTheDocument();
    expect(within(items[0]).getByText('Order #4: Pending → Confirmed')).toBeInTheDocument();
    expect(within(items[0]).getByText(/by admin@example\.com/)).toBeInTheDocument();
    expect(within(items[0]).getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument();
    expect(within(items[1]).getByText('Stock adjusted')).toBeInTheDocument();
    expect(within(items[1]).getByText('SKU-1004 — 27-inch Monitor: +5 units')).toBeInTheDocument();
    expect(within(items[1]).getByText(/by Sam/)).toBeInTheDocument(); // the display name wins over the email
    expect(screen.getByText('2 events')).toBeInTheDocument();
  });

  test('groups the events under their day, newest day first', async () => {
    events = [orderEvent(3, 'ORDER_CONFIRMED'), stockEvent(2), orderEvent(1, 'ORDER_CREATED', { fromStatus: null, toStatus: 'PENDING' }, DAY2)];
    await renderLoaded();
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings).toHaveLength(2);
    expect(headings[0].textContent).toMatch(/27/);
    expect(headings[1].textContent).toMatch(/26/);
  });

  test('an event type it does not know is still listed', async () => {
    events = [{ ...auditEvent(1, 'SOMETHING_NEW', { type: 'settings', id: null, label: 'Settings' }, null) }];
    await renderLoaded();
    expect(screen.getByText('Something new')).toBeInTheDocument();
  });

  test('says honestly what the history contains and does not contain', async () => {
    events = [stockEvent(1)];
    await renderLoaded();
    expect(screen.getByText(/shown from when the activity log was introduced/)).toBeInTheDocument();
    expect(screen.getByText(/Earlier changes of those kinds are not available/)).toBeInTheDocument();
  });
});

describe('event details', () => {
  test('an order confirmation shows the customer, the total and the stock it deducted, inside the event', async () => {
    events = [
      orderEvent(2, 'ORDER_CONFIRMED', { stockMovements: [{ productId: 5, sku: 'SKU-1004', productName: '27-inch Monitor', quantityDelta: -3 }] }),
    ];
    const onNavigate = await renderLoaded();
    expect(screen.queryByText('Stock deducted by this confirmation')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Show details: Order confirmed, Order #4/ }));
    expect(screen.getByText('Ann Lee')).toBeInTheDocument();
    expect(screen.getByText('31.50')).toBeInTheDocument();
    expect(screen.getByText('Pending → Confirmed')).toBeInTheDocument();
    expect(screen.getByText('Stock deducted by this confirmation')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'SKU-1004' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '−3' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open order #4' }));
    expect(onNavigate).toHaveBeenCalledWith('orders', '?order=4');
  });

  test('a cancellation shows the stock put back; a cancellation that moved no stock says so', async () => {
    events = [
      orderEvent(3, 'ORDER_CANCELLED', { fromStatus: 'CONFIRMED', toStatus: 'CANCELLED', stockMovements: [{ productId: 5, sku: 'SKU-1004', productName: 'Monitor', quantityDelta: 3 }] }),
      { ...orderEvent(4, 'ORDER_CANCELLED', { fromStatus: 'PENDING', toStatus: 'CANCELLED', stockMovements: [] }), id: 'order-99', entity: { type: 'order', id: 1, label: 'Order #1' } },
    ];
    await renderLoaded();
    fireEvent.click(screen.getAllByRole('button', { name: /Show details/ })[0]);
    expect(screen.getByText('Stock put back by this cancellation')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '+3' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /Show details/ })[0]); // the second one (the first is now "Hide")
    expect(screen.getByText('No stock movement is recorded for this event.')).toBeInTheDocument();
  });

  test('created, shipped and delivered orders show no stock table and no "no movement" claim', async () => {
    events = [orderEvent(1, 'ORDER_SHIPPED', { fromStatus: 'CONFIRMED', toStatus: 'SHIPPED' })];
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Show details/ }));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText(/No stock movement/)).not.toBeInTheDocument();
  });

  test('a manual stock adjustment shows the product, the change and the reason', async () => {
    events = [stockEvent(1)];
    const onNavigate = await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Show details/ }));
    expect(screen.getByText('Recount after delivery')).toBeInTheDocument();
    expect(screen.getByText('+5')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Inventory' }));
    expect(onNavigate).toHaveBeenCalledWith('inventory');
  });

  test('a product edit names the fields, shows the price change, and says SKU and name text is not kept', async () => {
    events = [
      auditEvent(1, 'PRODUCT_UPDATED', { type: 'product', id: 5, label: 'SKU-1004 — 27-inch Monitor' }, {
        changedFields: ['name', 'price'],
        changes: { price: { from: '24.50', to: '29.00' } },
      }),
    ];
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Show details/ }));
    expect(within(screen.getByRole('list', { name: 'Fields changed' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Name', 'Price']);
    expect(screen.getByText('24.50 → 29.00')).toBeInTheDocument();
    expect(screen.getByText(/records that the SKU or name changed, but not the old or new text/)).toBeInTheDocument();
  });

  test('a customer edit shows field names only and says customer details are not kept', async () => {
    events = [auditEvent(1, 'CUSTOMER_UPDATED', { type: 'customer', id: 9, label: 'Ann Lee' }, { changedFields: ['email', 'phone'] })];
    const onNavigate = await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Show details/ }));
    expect(screen.getByText('Customer details are never copied into the activity log.')).toBeInTheDocument();
    // Neither the customer's email nor phone number appears anywhere on the page (only the administrator's own email does).
    expect(document.body.textContent).not.toMatch(/ann@|555/);
    fireEvent.click(screen.getByRole('button', { name: 'Open Customers' }));
    expect(onNavigate).toHaveBeenCalledWith('customers');
  });

  test('a settings change shows the old and new threshold; a password change shows no details', async () => {
    events = [
      auditEvent(1, 'SETTINGS_UPDATED', { type: 'settings', id: null, label: 'Settings' }, { key: 'low_stock_threshold', from: 5, to: 8 }),
      auditEvent(2, 'ACCOUNT_PASSWORD_CHANGED', { type: 'account', id: 7, label: 'Administrator account' }, null),
    ];
    await renderLoaded();
    fireEvent.click(screen.getAllByRole('button', { name: /Show details/ })[0]);
    expect(screen.getAllByText('5 → 8').length).toBeGreaterThan(0);
    expect(screen.getByText('Low-stock threshold')).toBeInTheDocument();
    // Opening the second event closes the first (one at a time). A password change has no details to show.
    fireEvent.click(screen.getAllByRole('button', { name: /Show details/ })[0]);
    expect(screen.queryByText('Low-stock threshold')).not.toBeInTheDocument();
    expect(screen.getByText(/Recorded .* by admin@example\.com/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Fields changed' })).not.toBeInTheDocument();
  });

  test('only one event is open at a time, and Hide closes it', async () => {
    events = [stockEvent(1), orderEvent(2, 'ORDER_CONFIRMED')];
    await renderLoaded();
    fireEvent.click(screen.getAllByRole('button', { name: /Show details/ })[0]);
    expect(screen.getAllByRole('button', { name: /Hide details/ })).toHaveLength(1);
    fireEvent.click(screen.getAllByRole('button', { name: /Show details/ })[0]);
    expect(screen.getAllByRole('button', { name: /Hide details/ })).toHaveLength(1);
    expect(screen.queryByText('Recount after delivery')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Hide details/ }));
    expect(screen.queryByRole('button', { name: /Hide details/ })).not.toBeInTheDocument();
  });
});

describe('search, type and date filters', () => {
  test('search is sent to the server after a pause and returns to page 1', async () => {
    events = [stockEvent(1)];
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('Search activity'), { target: { value: ' monitor ' } });
    await waitFor(() => expect(params().get('q')).toBe('monitor'));
    expect(params().get('page')).toBe('1');
  });

  test('choosing a type asks the server for that group', async () => {
    events = [stockEvent(1)];
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'stock' } });
    await waitFor(() => expect(params().get('type')).toBe('stock'));
    const options = within(screen.getByLabelText('Type')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['All activity', 'Orders', 'Stock adjustments', 'Products', 'Customers', 'Account', 'Settings']);
  });

  test('the date range is sent as the start of the first day and the start of the day after the last', async () => {
    events = [stockEvent(1)];
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-26' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-27' } });
    await waitFor(() => expect(params().get('to')).toBeTruthy());
    expect(params().get('from')).toBe(new Date(2026, 9, 26).toISOString());
    expect(params().get('to')).toBe(new Date(2026, 9, 28).toISOString());
  });

  test('an end date before the start date is explained and no request is made for it', async () => {
    events = [stockEvent(1)];
    await renderLoaded();
    const callsBefore = urls().length;
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-20' } });
    await waitFor(() => expect(params().get('to')).toBeTruthy());
    const callsWithTo = urls().length;
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-25' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('The end date must be the same as or after the start date.');
    expect(urls().length).toBe(callsWithTo);
    expect(callsWithTo).toBeGreaterThan(callsBefore);
    expect(screen.getByLabelText('From')).toHaveAttribute('aria-invalid', 'true');
    // fixing the range loads again
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-27' } });
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  test('Clear filters resets search, type and dates', async () => {
    events = [stockEvent(1)];
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'order' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-26' } });
    fireEvent.change(screen.getByLabelText('Search activity'), { target: { value: 'ann' } });
    await waitFor(() => expect(params().get('q')).toBe('ann'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(lastUrl()).toBe('/api/activity?type=all&page=1&pageSize=25'));
    expect(screen.getByLabelText('Search activity')).toHaveValue('');
    expect(screen.getByLabelText('From')).toHaveValue('');
  });
});

describe('pagination', () => {
  test('shows the range and asks the server for the next page', async () => {
    events = Array.from({ length: 25 }, (_, i) => stockEvent(i + 1));
    total = 60;
    await renderLoaded();
    expect(screen.getByText('Showing 1–25 of 60')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(params().get('page')).toBe('2'));
  });

  test('changing a filter on a later page returns to page 1', async () => {
    events = Array.from({ length: 25 }, (_, i) => stockEvent(i + 1));
    total = 60;
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(params().get('page')).toBe('2'));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'stock' } });
    await waitFor(() => expect(params().get('type')).toBe('stock'));
    expect(params().get('page')).toBe('1');
  });
});

describe('empty, loading and error states', () => {
  test('shows a loading state before the first answer', () => {
    fetch.mockImplementation(() => new Promise(() => {}));
    render(<ActivityPage debounceMs={5} onNavigate={vi.fn()} />);
    expect(screen.getByText('Loading activity…')).toBeInTheDocument();
  });

  test('no activity at all: says so and does not invent anything', async () => {
    await renderLoaded();
    expect(screen.getByText('No activity has been recorded yet.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  test('nothing matches the filters: says so and offers Clear filters', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'customer' } });
    expect(await screen.findByText('No recorded activity matches these filters.')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' }).at(-1));
    await waitFor(() => expect(screen.getByText('No activity has been recorded yet.')).toBeInTheDocument());
  });

  test('a failed request shows an error with Try again, and no list', async () => {
    failWith = () => reply({ error: 'Internal server error' }, 500);
    render(<ActivityPage debounceMs={5} onNavigate={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Activity could not be loaded. Please try again.');
    expect(screen.queryByText(/events?$/)).not.toBeInTheDocument();
    failWith = null;
    events = [stockEvent(1)];
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Stock adjusted')).toBeInTheDocument();
  });

  test('a lost connection and a rejected filter each get their own message', async () => {
    failWith = () => {
      throw new TypeError('offline');
    };
    const { unmount } = render(<ActivityPage debounceMs={5} onNavigate={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server');
    unmount();
    failWith = () => reply({ error: 'Invalid request', fields: ['type'] }, 400);
    render(<ActivityPage debounceMs={5} onNavigate={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The filters were not accepted');
  });

  test('a 200 reply without a list is an error, not an endless spinner', async () => {
    failWith = () => reply({});
    render(<ActivityPage debounceMs={5} onNavigate={vi.fn()} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Loading activity…')).not.toBeInTheDocument();
  });
});

describe('search wording matches what the server really searches', () => {
  test('the placeholder and the hint describe order number, customer, SKU/product and administrator', async () => {
    events = [stockEvent(1)];
    await renderLoaded();
    const input = screen.getByLabelText('Search activity');
    expect(input).toHaveAttribute('placeholder', 'Search order number, customer, SKU or administrator');
    const hint = screen.getByText(/Matches order number \(12 or #12\), customer name, product SKU or name, and administrator/);
    expect(input.getAttribute('aria-describedby')).toBe(hint.id);
  });

  test('it does not claim that orders can be found by the products they contain', async () => {
    events = [stockEvent(1)];
    await renderLoaded();
    expect(screen.getByText(/Orders are not searched by the\s+products they contain\./)).toBeInTheDocument();
    expect(screen.getByLabelText('Search activity').getAttribute('placeholder')).not.toMatch(/product/i);
  });
});

describe('a malformed event never takes the page down', () => {
  let errorSpy;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // React reports caught render errors here
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  test('events with missing details still get a row, a plain summary, and details that open', async () => {
    events = [
      { ...orderEvent(1, 'ORDER_CREATED'), details: null },
      { ...stockEvent(2), details: null },
      { ...orderEvent(3, 'ORDER_CONFIRMED'), details: {} },
    ];
    await renderLoaded();
    expect(screen.getAllByRole('button', { name: /Show details/ })).toHaveLength(3);
    expect(screen.getByText('SKU-1004 — 27-inch Monitor')).toBeInTheDocument(); // no quantity: just the product
    expect(screen.getAllByText('Order #4')).toHaveLength(2); // no customer or statuses: just the order
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getAllByRole('button', { name: /Show details/ })[0]);
      fireEvent.click(screen.getByRole('button', { name: /Hide details/ }));
    }
    expect(screen.queryByText('This event could not be displayed.')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/undefined|NaN|null/);
  });

  test('items in the list that are not events (null, text, numbers) are skipped', async () => {
    events = [null, stockEvent(1), 'oops', 42, [], stockEvent(2)];
    await renderLoaded();
    expect(screen.getAllByRole('button', { name: /Show details/ })).toHaveLength(2);
    expect(screen.queryByText('This event could not be displayed.')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();
  });

  test('events without an id each keep their own row and open on their own', async () => {
    const noId = (n) => ({ ...stockEvent(n), id: undefined });
    events = [noId(1), noId(2)];
    await renderLoaded();
    fireEvent.click(screen.getAllByRole('button', { name: /Show details/ })[1]);
    expect(screen.getAllByRole('button', { name: /Hide details/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /Show details/ })).toHaveLength(1);
  });

  test('a row that fails when its details open is replaced by a notice; the other rows and the filters keep working', async () => {
    // An order event that arrived without its entity: drawing the row is fine, but opening its details used to throw.
    const broken = { id: 'order-9', type: 'ORDER_CREATED', occurredAt: DAY1, actor: ADMIN, entity: null, details: { fromStatus: null, toStatus: 'PENDING', customerName: 'Ann Lee', totalAmount: '1.00', stockMovements: [] } };
    events = [stockEvent(1), broken, orderEvent(3, 'ORDER_CONFIRMED')];
    await renderLoaded();

    const toggles = screen.getAllByRole('button', { name: /Show details/ });
    expect(toggles).toHaveLength(3);
    fireEvent.click(toggles[1]);

    expect(screen.getByText('This event could not be displayed.')).toBeInTheDocument();
    expect(screen.getByText('Event type: ORDER_CREATED')).toBeInTheDocument();
    // everything else is still there and still works
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByText('Stock adjusted')).toBeInTheDocument();
    expect(screen.getByText('Order confirmed')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /Show details/ })[0]);
    expect(screen.getByText('Recount after delivery')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search activity'), { target: { value: 'ann' } });
    await waitFor(() => expect(params().get('q')).toBe('ann'));
  });

  test('a row whose type is not even text also fails safely, without a type line', async () => {
    events = [{ id: 'x-1', type: 7, occurredAt: DAY1, actor: ADMIN, entity: { type: 'order', id: 1, label: 'Order #1' }, details: null }, stockEvent(1)];
    await renderLoaded();
    fireEvent.click(screen.getAllByRole('button', { name: /Show details/ })[0]);
    expect(screen.getByText('This event could not be displayed.')).toBeInTheDocument();
    expect(screen.queryByText(/Event type:/)).not.toBeInTheDocument();
    expect(screen.getByText('Stock adjusted')).toBeInTheDocument();
  });

  test('after a reload with fresh data the failed row is drawn normally again', async () => {
    const broken = { id: 'order-9', type: 'ORDER_CREATED', occurredAt: DAY1, actor: ADMIN, entity: null, details: { fromStatus: null, toStatus: 'PENDING', customerName: 'Ann Lee', totalAmount: '1.00', stockMovements: [] } };
    events = [broken, stockEvent(1)];
    await renderLoaded();
    fireEvent.click(screen.getAllByRole('button', { name: /Show details/ })[0]);
    expect(screen.getByText('This event could not be displayed.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'order' } }); // a new request returns new event objects
    await waitFor(() => expect(params().get('type')).toBe('order'));
    await waitFor(() => expect(screen.queryByText('This event could not be displayed.')).not.toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: /Show details/ })).toHaveLength(2);
  });
});
