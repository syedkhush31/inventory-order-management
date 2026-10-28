// The Stock history panel and the listStockAdjustments API call, with a fake fetch: no server or database involved.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import StockHistory from './StockHistory.jsx';
import { listStockAdjustments } from '../api/products.js';
import { setUnauthorizedHandler } from '../api/client.js';

const PRODUCT = { id: 9, sku: 'SKU-1004', name: '27-inch Monitor', stockQuantity: 30, isActive: true };

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const adjustment = (id, overrides = {}) => ({
  id,
  productId: 9,
  quantityDelta: 5,
  reason: `Reason ${id}`,
  adminId: 1,
  createdAt: '2026-10-28T10:13:44.000Z',
  ...overrides,
});

const page = (items, { pageNumber = 1, total = items.length, pageSize = 10 } = {}) => ({
  items,
  page: pageNumber,
  pageSize,
  total,
  totalPages: Math.ceil(total / pageSize),
});

const urls = () => fetch.mock.calls.map(([url]) => url);

function setup() {
  const onClose = vi.fn();
  render(<StockHistory product={PRODUCT} onClose={onClose} />);
  return { onClose };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

describe('the API call', () => {
  test('GETs the history with cookies, the page numbers and an encoded id', async () => {
    fetch.mockImplementation(async () => reply(page([])));
    await listStockAdjustments(9, { page: 2, pageSize: 10 });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/products/9/stock-adjustments?page=2&pageSize=10');
    expect(options.method).toBe('GET');
    expect(options.credentials).toBe('include');

    await listStockAdjustments('a/b?c', { page: 1, pageSize: 10 });
    expect(fetch.mock.calls[1][0]).toBe('/api/products/a%2Fb%3Fc/stock-adjustments?page=1&pageSize=10');
  });

  test('passes the abort signal to fetch', async () => {
    fetch.mockImplementation(async () => reply(page([])));
    const controller = new AbortController();
    await listStockAdjustments(9, { page: 1, pageSize: 10 }, { signal: controller.signal });
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
  });
});

describe('loading and success', () => {
  test('shows a loading state first, then the history table', async () => {
    let finish;
    fetch.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    setup();
    expect(screen.getByRole('heading', { name: 'Stock history: SKU-1004' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading stock history…');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    finish(reply(page([adjustment(2, { quantityDelta: -3, reason: 'Damaged', adminId: 4 }), adjustment(1)])));
    expect(await screen.findByRole('table', { name: 'Stock history for SKU-1004' })).toBeInTheDocument();
    expect(screen.queryByText('Loading stock history…')).not.toBeInTheDocument();
  });

  test('shows date, signed change, reason and administrator ID for each row, in the order received', async () => {
    fetch.mockImplementation(async () =>
      reply(page([adjustment(2, { quantityDelta: -3, reason: 'Damaged', adminId: 4 }), adjustment(1, { reason: 'recieved 5 units in warehouse' })]))
    );
    setup();
    await screen.findByRole('table');

    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Date and time',
      'Change',
      'Reason',
      'Administrator ID',
    ]);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('-3')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Damaged')).toBeInTheDocument();
    expect(within(rows[0]).getByText('4')).toBeInTheDocument();
    expect(within(rows[1]).getByText('+5')).toBeInTheDocument();
    expect(within(rows[1]).getByText('recieved 5 units in warehouse')).toBeInTheDocument();
    expect(within(rows[1]).getByText('1')).toBeInTheDocument();
    expect(within(rows[1]).getAllByRole('cell')[0].textContent).not.toBe(''); // a formatted date is shown
  });

  test('shows a reason as plain text, never as HTML', async () => {
    fetch.mockImplementation(async () => reply(page([adjustment(1, { reason: '<img src=x onerror=alert(1)> <b>bold</b>' })])));
    setup();
    await screen.findByRole('table');
    expect(screen.getByText('<img src=x onerror=alert(1)> <b>bold</b>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });

  test('formats large changes with thousands separators', async () => {
    fetch.mockImplementation(async () => reply(page([adjustment(1, { quantityDelta: 12000 })])));
    setup();
    expect(await screen.findByText('+12,000')).toBeInTheDocument();
  });

  test('Close calls onClose', async () => {
    fetch.mockImplementation(async () => reply(page([adjustment(1)])));
    const { onClose } = setup();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('empty history', () => {
  test('explains that nothing has been recorded and shows no table', async () => {
    fetch.mockImplementation(async () => reply(page([])));
    setup();
    expect(await screen.findByText('No stock corrections have been recorded for this product yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).not.toBeInTheDocument();
  });
});

describe('pagination', () => {
  const twentyThree = (n) => Array.from({ length: n }, (_, i) => adjustment(100 - i));

  test('shows the range and moves between pages by requesting each page from the server', async () => {
    fetch.mockImplementation(async (url) => {
      const pageNumber = Number(new URL(url, 'http://x').searchParams.get('page'));
      const count = pageNumber === 3 ? 3 : 10;
      return reply(page(twentyThree(count), { pageNumber, total: 23 }));
    });
    setup();
    await screen.findByRole('table');
    expect(screen.getByText('Showing 1–10 of 23')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2 of 3');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 3 of 3');
    expect(screen.getByText('Showing 21–23 of 23')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByText('Page 2 of 3');
    expect(urls()).toEqual([
      '/api/products/9/stock-adjustments?page=1&pageSize=10',
      '/api/products/9/stock-adjustments?page=2&pageSize=10',
      '/api/products/9/stock-adjustments?page=3&pageSize=10',
      '/api/products/9/stock-adjustments?page=2&pageSize=10',
    ]);
  });

  test('a single page has no usable Next button', async () => {
    fetch.mockImplementation(async () => reply(page([adjustment(1), adjustment(2)])));
    setup();
    await screen.findByRole('table');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  test('if the current page disappears (fewer rows than before) it jumps to the last real page', async () => {
    fetch.mockImplementation(async (url) => {
      const pageNumber = Number(new URL(url, 'http://x').searchParams.get('page'));
      if (pageNumber === 1) return reply(page(twentyThree(10), { pageNumber: 1, total: 11 }));
      if (pageNumber === 2) return reply(page(twentyThree(1), { pageNumber: 2, total: 11 }));
      return reply(page([], { pageNumber, total: 11 }));
    });
    setup();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2 of 2');
  });
});

describe('errors', () => {
  test('a server error shows a message and Try again loads the history', async () => {
    fetch.mockImplementationOnce(async () => reply({ error: 'Internal server error' }, 500));
    setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('The stock history could not be loaded. Please try again.');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    fetch.mockImplementation(async () => reply(page([adjustment(1)])));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('a network failure says the server cannot be reached', async () => {
    fetch.mockImplementation(async () => {
      throw new TypeError('failed');
    });
    setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server');
  });

  test('a 404 says the product no longer exists', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Product not found' }, 404));
    setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('This product no longer exists');
  });

  test('a 400 (invalid request) shows the generic message, with no server details', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Invalid request', fields: ['id'] }, 400));
    setup();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The stock history could not be loaded');
    expect(alert).not.toHaveTextContent('fields');
  });

  test('a 200 reply without a list does not leave the panel loading forever', async () => {
    fetch.mockImplementation(async () => reply({}));
    setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
  });

  test('a 401 (session ended) tells the app to return to the login page', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetch.mockImplementation(async () => reply({ error: 'Authentication required' }, 401));
    setup();
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
