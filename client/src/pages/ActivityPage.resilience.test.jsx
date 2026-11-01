// A row that throws while the page is DRAWING it (not just when its details open). Real JSON from the server cannot do
// that, so the activity API module is replaced here and hands the page objects that throw when they are read.
// The page must show a notice for that one row and keep everything else working.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../api/activity.js', () => ({ listActivity: vi.fn() }));

import { listActivity } from '../api/activity.js';
import ActivityPage from './ActivityPage.jsx';

const ADMIN = { id: 7, email: 'admin@example.com', displayName: null };
const WHEN = '2026-10-27T12:00:00.000Z';

const good = (n) => ({
  id: `stock-${n}`,
  type: 'STOCK_ADJUSTED',
  occurredAt: WHEN,
  actor: ADMIN,
  entity: { type: 'product', id: 5, label: 'SKU-1004 — 27-inch Monitor' },
  details: { productId: 5, sku: 'SKU-1004', productName: '27-inch Monitor', quantityDelta: 5, reason: 'Recount' },
});

// Every property read of `details` throws, so summarise() fails while the row is being drawn.
const exploding = (n) => ({
  id: `order-${n}`,
  type: 'ORDER_CREATED',
  occurredAt: WHEN,
  actor: ADMIN,
  entity: { type: 'order', id: 4, label: 'Order #4' },
  details: new Proxy({}, { get() { throw new Error('boom while reading details'); } }),
});

let errorSpy;

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.clearAllMocks();
});

function reply(items) {
  return { items, page: 1, pageSize: 25, total: items.length, totalPages: 1 };
}

describe('a row that throws while it is drawn', () => {
  test('is replaced by a notice and the rest of the page is untouched', async () => {
    listActivity.mockResolvedValue(reply([good(1), exploding(2), good(3)]));
    render(<ActivityPage debounceMs={5} />);

    expect(await screen.findByText('This event could not be displayed.')).toBeInTheDocument();
    expect(screen.getByText('Event type: ORDER_CREATED')).toBeInTheDocument();
    expect(screen.getAllByText('Stock adjusted')).toHaveLength(2); // both good rows are there
    expect(screen.getAllByRole('button', { name: /Show details/ })).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByLabelText('Search activity')).toBeInTheDocument();
    expect(screen.getByText('3 events')).toBeInTheDocument(); // the count still comes from the server
    expect(document.body.textContent).not.toMatch(/boom while reading details/); // the error text is not shown to the user
  });

  test('the good rows still open, close and navigate', async () => {
    listActivity.mockResolvedValue(reply([exploding(1), good(2)]));
    const onNavigate = vi.fn();
    render(<ActivityPage debounceMs={5} onNavigate={onNavigate} />);
    await screen.findByText('This event could not be displayed.');
    fireEvent.click(screen.getByRole('button', { name: /Show details/ }));
    expect(screen.getByText('Recount')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Inventory' }));
    expect(onNavigate).toHaveBeenCalledWith('inventory');
  });

  test('searching and paging still work after a row failed', async () => {
    listActivity.mockResolvedValue(reply([exploding(1)]));
    render(<ActivityPage debounceMs={5} />);
    await screen.findByText('This event could not be displayed.');
    listActivity.mockResolvedValue(reply([good(9)]));
    fireEvent.change(screen.getByLabelText('Search activity'), { target: { value: 'monitor' } });
    await waitFor(() => expect(listActivity).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'monitor' }), expect.anything()));
    expect(await screen.findByText('Stock adjusted')).toBeInTheDocument();
    expect(screen.queryByText('This event could not be displayed.')).not.toBeInTheDocument();
  });

  test('if every row fails, the page itself is still there with its filters and an honest count', async () => {
    listActivity.mockResolvedValue(reply([exploding(1), exploding(2)]));
    render(<ActivityPage debounceMs={5} />);
    await waitFor(() => expect(screen.getAllByText('This event could not be displayed.')).toHaveLength(2));
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByLabelText('Type')).toBeInTheDocument();
    expect(screen.getByText('2 events')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // not reported as a failed load: the load worked
  });
});
