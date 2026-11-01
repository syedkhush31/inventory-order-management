// Order details and status actions with a fake fetch. Nothing here talks to a real server or database.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import OrderDetail from './OrderDetail.jsx';

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const makeOrder = (status, overrides = {}) => ({
  id: 7,
  status,
  totalAmount: '31.50',
  customer: { id: 3, name: 'Ann Lee', email: 'ann@example.com', isActive: true },
  items: [
    { id: 1, productId: 5, sku: 'AAA-1', productName: 'Widget', quantity: 3, unitPrice: '10.50', lineTotal: '31.50' },
  ],
  statusHistory: [{ id: 1, fromStatus: null, toStatus: 'PENDING', changedByAdminId: 1, changedAt: '2026-10-27T10:00:00.000Z' }],
  createdAt: '2026-10-27T10:00:00.000Z',
  updatedAt: '2026-10-27T10:00:00.000Z',
  ...overrides,
});

let current;
let actionHandler;

beforeEach(() => {
  current = makeOrder('PENDING');
  actionHandler = async () => reply({ order: current });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options = {}) => {
      if (options.method === 'POST') return actionHandler(String(url).split('/').pop());
      return reply({ order: current });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const posts = () => fetch.mock.calls.filter(([, options]) => options?.method === 'POST');

async function renderDetail() {
  const onChanged = vi.fn();
  const onClose = vi.fn();
  render(<OrderDetail orderId={7} onChanged={onChanged} onClose={onClose} />);
  await screen.findByText('Ann Lee');
  return { onChanged, onClose };
}

const buttonNames = () =>
  screen
    .getAllByRole('button')
    .map((b) => b.textContent)
    .filter((t) => !['Close', 'Reload order', 'Reload details'].includes(t));

test('shows the customer, lines with snapshot prices, the total and the status history', async () => {
  await renderDetail();
  expect(screen.getByText('ann@example.com')).toBeInTheDocument();
  expect(screen.getByText('AAA-1')).toBeInTheDocument();
  expect(screen.getByText('Widget')).toBeInTheDocument();
  expect(screen.getAllByText('31.50')).toHaveLength(2); // line total and order total
  expect(screen.getByText('10.50')).toBeInTheDocument();
  expect(screen.getByText(/Created as/)).toBeInTheDocument();
});

test('a failed load shows an error with Try again', async () => {
  fetch.mockImplementation(async () => reply({ error: 'Order not found' }, 404));
  render(<OrderDetail orderId={7} onChanged={vi.fn()} onClose={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('no longer exists');
});

describe('only valid actions are offered', () => {
  test.each([
    ['PENDING', ['Confirm order', 'Cancel order']],
    ['CONFIRMED', ['Mark as shipped', 'Cancel order']],
    ['SHIPPED', ['Mark as delivered']],
    ['DELIVERED', []],
    ['CANCELLED', []],
  ])('%s', async (status, expected) => {
    current = makeOrder(status);
    await renderDetail();
    expect(buttonNames()).toEqual(expected);
  });
});

describe('running an action', () => {
  test('confirm updates the order from the server reply and tells the parent', async () => {
    actionHandler = async () => reply({ order: makeOrder('CONFIRMED') });
    const { onChanged } = await renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm order' }));
    expect(await screen.findByRole('button', { name: 'Mark as shipped' })).toBeInTheDocument();
    expect(posts()[0][0]).toBe('/api/orders/7/confirm');
    expect(onChanged).toHaveBeenCalledWith('Order #7 is now Confirmed.');
  });

  test('buttons are disabled while in flight and a double click sends one request', async () => {
    let finish;
    actionHandler = () => new Promise((resolve) => (finish = () => resolve(reply({ order: makeOrder('CONFIRMED') }))));
    await renderDetail();
    const confirm = screen.getByRole('button', { name: 'Confirm order' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(await screen.findByRole('button', { name: 'Confirming…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel order' })).toBeDisabled();
    expect(posts()).toHaveLength(1);
    finish();
    await screen.findByRole('button', { name: 'Mark as shipped' });
  });

  test('cancelling needs a second confirmation, and Keep order sends nothing', async () => {
    await renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }));
    expect(screen.getByText(/Cancel order #7\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep order' }));
    expect(posts()).toHaveLength(0);

    actionHandler = async () => reply({ order: makeOrder('CANCELLED') });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel order' }));
    await waitFor(() => expect(buttonNames()).toEqual([]));
    expect(posts()[0][0]).toBe('/api/orders/7/cancel');
  });

  test('a partial success says it was saved, hides the actions and offers a reload', async () => {
    actionHandler = async () => reply({ order: null, orderId: 7, status: 'CONFIRMED', detailsAvailable: false });
    const { onChanged } = await renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm order' }));
    expect(await screen.findByText(/The change was saved/)).toBeInTheDocument();
    expect(screen.getByText(/Do not repeat the action/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm order' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel order' })).not.toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledWith('Order #7 is now Confirmed.');

    current = makeOrder('CONFIRMED');
    fireEvent.click(screen.getByRole('button', { name: 'Reload details' }));
    expect(await screen.findByRole('button', { name: 'Mark as shipped' })).toBeInTheDocument();
    expect(screen.queryByText(/The change was saved/)).not.toBeInTheDocument();
  });
});

describe('failed actions never look like success', () => {
  test('409 shortages name the products and say nothing was deducted', async () => {
    actionHandler = async () =>
      reply({ error: 'Not enough stock to confirm this order', shortages: [{ productId: 5, requested: 3, available: 1 }] }, 409);
    const { onChanged } = await renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm order' }));
    expect(await screen.findByText(/not enough stock/i)).toBeInTheDocument();
    expect(screen.getByText('Widget: needs 3, only 1 in stock')).toBeInTheDocument();
    expect(screen.getByText(/nothing was deducted/)).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm order' })).toBeEnabled();
  });

  test('409 invalid transition explains the current status and refreshes the order', async () => {
    actionHandler = async () => {
      current = makeOrder('CANCELLED');
      return reply({ error: 'This order is CANCELLED and cannot be changed to CONFIRMED', currentStatus: 'CANCELLED' }, 409);
    };
    const { onChanged } = await renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm order' }));
    expect(await screen.findByText(/now Cancelled/)).toBeInTheDocument();
    await waitFor(() => expect(buttonNames()).toEqual([]));
    expect(onChanged).not.toHaveBeenCalled();
  });

  test('503 busy says the action was NOT completed and keeps the actions available', async () => {
    actionHandler = async () => reply({ error: 'busy' }, 503);
    const { onChanged } = await renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm order' }));
    expect(await screen.findByText(/NOT completed/)).toBeInTheDocument();
    expect(screen.queryByText(/is now Confirmed/)).not.toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm order' })).toBeEnabled();
  });

  test('a network error says the order may not have changed and offers a reload before retrying', async () => {
    actionHandler = async () => {
      throw new TypeError('offline');
    };
    await renderDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm order' }));
    expect(await screen.findByText(/may not have been updated/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload order' })).toBeInTheDocument();
  });
});
