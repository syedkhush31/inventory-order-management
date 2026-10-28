// "View stock history" on the Inventory page, with a fake fetch. Nothing here talks to a real server or database.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import InventoryPage from './InventoryPage.jsx';
import { setUnauthorizedHandler } from '../api/client.js';

const makeProduct = (n) => ({
  id: n,
  sku: `SKU-${n}`,
  name: `Product ${n}`,
  price: '10.00',
  stockQuantity: 5,
  isActive: true,
  createdAt: '2026-10-27T10:00:00.000Z',
  updatedAt: '2026-10-27T10:00:00.000Z',
});

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let historyHandler;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  historyHandler = async () =>
    reply({
      items: [{ id: 1, productId: 2, quantityDelta: 5, reason: 'Received delivery', adminId: 1, createdAt: '2026-10-28T10:13:44.000Z' }],
      page: 1,
      pageSize: 10,
      total: 1,
      totalPages: 1,
    });
  fetch.mockImplementation(async (url, options = {}) => {
    if (/\/stock-adjustments/.test(url)) return historyHandler(url, options);
    return reply({ items: [makeProduct(1), makeProduct(2)], page: 1, pageSize: 25, total: 2, totalPages: 1 });
  });
});

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

async function renderLoaded() {
  render(<InventoryPage debounceMs={5} />);
  await screen.findByText('Product 1');
}

const historyCalls = () => fetch.mock.calls.filter(([url]) => /\/stock-adjustments/.test(url));

describe('View stock history action', () => {
  test('every row has a "View stock history" button named after its SKU', async () => {
    await renderLoaded();
    expect(screen.getByRole('button', { name: 'View stock history for SKU-1' })).toHaveTextContent('View stock history');
    expect(screen.getByRole('button', { name: 'View stock history for SKU-2' })).toBeInTheDocument();
    expect(historyCalls()).toHaveLength(0); // nothing is fetched until it is clicked
  });

  test('opens the history for that product only, and it is a GET', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'View stock history for SKU-2' }));

    expect(await screen.findByRole('heading', { name: 'Stock history: SKU-2' })).toBeInTheDocument();
    expect(await screen.findByText('Received delivery')).toBeInTheDocument();
    expect(historyCalls()).toHaveLength(1);
    expect(historyCalls()[0][0]).toBe('/api/products/2/stock-adjustments?page=1&pageSize=10');
    expect(historyCalls()[0][1].method).toBe('GET');
  });

  test('Close hides the panel', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'View stock history for SKU-1' }));
    await screen.findByText('Received delivery');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('heading', { name: /Stock history/ })).not.toBeInTheDocument();
  });

  test('is a single shared panel: opening Edit or another product replaces it', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'View stock history for SKU-1' }));
    await screen.findByRole('heading', { name: 'Stock history: SKU-1' });

    fireEvent.click(screen.getByRole('button', { name: 'View stock history for SKU-2' }));
    expect(await screen.findByRole('heading', { name: 'Stock history: SKU-2' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Stock history: SKU-1' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit SKU-1' }));
    expect(screen.queryByRole('heading', { name: /Stock history/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Edit product' })).toBeInTheDocument();
  });

  test('shows the empty state for a product with no corrections', async () => {
    historyHandler = async () => reply({ items: [], page: 1, pageSize: 10, total: 0, totalPages: 0 });
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'View stock history for SKU-1' }));
    expect(await screen.findByText('No stock corrections have been recorded for this product yet.')).toBeInTheDocument();
  });

  test('a history error is shown inside the panel and does not break the product list', async () => {
    historyHandler = async () => reply({ error: 'Internal server error' }, 500);
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'View stock history for SKU-1' }));
    const panel = (await screen.findByRole('heading', { name: 'Stock history: SKU-1' })).closest('section');
    await waitFor(() => expect(panel).toHaveTextContent('The stock history could not be loaded'));
    expect(screen.getByRole('cell', { name: 'Product 1' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Product 2' })).toBeInTheDocument();
  });
});
