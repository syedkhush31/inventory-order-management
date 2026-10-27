// Inventory page tests with a fake fetch: no backend or database is involved.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import InventoryPage from './InventoryPage.jsx';
import { setUnauthorizedHandler } from '../api/client.js';

const product = (overrides = {}) => ({
  id: 1,
  sku: 'SKU-1001',
  name: 'Wireless Mouse',
  price: '19.99',
  stockQuantity: 120,
  isActive: true,
  createdAt: '2026-10-27T10:00:00.000Z',
  updatedAt: '2026-10-27T11:00:00.000Z',
  ...overrides,
});

const page = (items, extra = {}) => ({
  items,
  page: 1,
  pageSize: 25,
  total: items.length,
  totalPages: items.length ? 1 : 0,
  ...extra,
});

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const urls = () => fetch.mock.calls.map(([url]) => url);
const lastUrl = () => urls().at(-1);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

describe('loading and showing products', () => {
  test('shows a loading state, then the real rows with formatted values', async () => {
    fetch.mockImplementation(async () =>
      reply(
        page([
          product(),
          product({ id: 2, sku: 'SKU-1004', name: '27-inch Monitor', price: '1189.00', stockQuantity: 0 }),
          product({ id: 3, sku: 'SKU-9', name: 'Old Cable', price: '7.25', stockQuantity: 1200, isActive: false }),
        ])
      )
    );
    render(<InventoryPage debounceMs={5} />);
    expect(screen.getByText('Loading products…')).toBeInTheDocument();

    expect(await screen.findByText('Wireless Mouse')).toBeInTheDocument();
    expect(lastUrl()).toBe('/api/products?status=active&page=1&pageSize=25&sort=name&order=asc');

    const rows = screen.getAllByRole('row');
    expect(within(rows[1]).getByText('SKU-1001')).toBeInTheDocument();
    expect(within(rows[1]).getByText('19.99')).toBeInTheDocument();
    expect(within(rows[1]).getByText('120')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Active')).toBeInTheDocument();

    expect(within(rows[2]).getByText('1,189.00')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Out of stock')).toBeInTheDocument();

    expect(within(rows[3]).getByText('1,200')).toBeInTheDocument();
    expect(within(rows[3]).getByText('Inactive')).toBeInTheDocument();
    expect(within(rows[3]).queryByText('Out of stock')).not.toBeInTheDocument();

    expect(screen.getByText('3 products')).toBeInTheDocument();
    expect(screen.getByText('Showing 1–3 of 3')).toBeInTheDocument();
  });

  test('uses the singular for one product', async () => {
    fetch.mockImplementation(async () => reply(page([product()])));
    render(<InventoryPage debounceMs={5} />);
    expect(await screen.findByText('1 product')).toBeInTheDocument();
  });
});

describe('search', () => {
  test('waits until typing stops, then sends a single request with the search text', async () => {
    fetch.mockImplementation(async () => reply(page([product()])));
    render(<InventoryPage debounceMs={40} />);
    await screen.findByText('Wireless Mouse');
    const before = urls().length;

    const box = screen.getByLabelText('Search products');
    fireEvent.change(box, { target: { value: 'm' } });
    fireEvent.change(box, { target: { value: 'mo' } });
    fireEvent.change(box, { target: { value: '  mouse ' } });
    expect(urls().length).toBe(before); // nothing sent while typing

    await waitFor(() => expect(lastUrl()).toContain('q=mouse'));
    expect(urls().length).toBe(before + 1);
    expect(urls().some((u) => u.includes('q=mo&'))).toBe(false);
  });

  test('shows a no-results message with a Clear search button that restores the list', async () => {
    fetch.mockImplementation(async (url) =>
      url.includes('q=zzz') ? reply(page([])) : reply(page([product()]))
    );
    render(<InventoryPage debounceMs={5} />);
    await screen.findByText('Wireless Mouse');

    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'zzz' } });
    expect(await screen.findByText('No products match “zzz”.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('Wireless Mouse')).toBeInTheDocument();
    expect(screen.getByLabelText('Search products')).toHaveValue('');
  });

  test('empty list without a search says there are no products for that status', async () => {
    fetch.mockImplementation(async () => reply(page([])));
    render(<InventoryPage debounceMs={5} />);
    expect(await screen.findByText('There are no active products.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'inactive' } });
    expect(await screen.findByText('There are no inactive products.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } });
    expect(await screen.findByText('No products have been added yet.')).toBeInTheDocument();
  });
});

describe('status filter', () => {
  test('requests the chosen status and goes back to page 1', async () => {
    fetch.mockImplementation(async () => reply(page([product()], { total: 60, totalPages: 3 })));
    render(<InventoryPage debounceMs={5} />);
    await screen.findByText('Wireless Mouse');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(lastUrl()).toContain('page=2'));

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } });
    await waitFor(() => expect(lastUrl()).toContain('status=all'));
    expect(lastUrl()).toContain('page=1');
  });
});

describe('sorting', () => {
  test('clicking a header sorts ascending, clicking again descending, and marks aria-sort', async () => {
    fetch.mockImplementation(async () => reply(page([product()])));
    render(<InventoryPage debounceMs={5} />);
    await screen.findByText('Wireless Mouse');

    const priceHeader = () => screen.getByRole('columnheader', { name: /Price/ });
    expect(screen.getByRole('columnheader', { name: /Product name/ })).toHaveAttribute('aria-sort', 'ascending');
    expect(priceHeader()).toHaveAttribute('aria-sort', 'none');

    fireEvent.click(within(priceHeader()).getByRole('button'));
    await waitFor(() => expect(lastUrl()).toContain('sort=price&order=asc'));
    expect(priceHeader()).toHaveAttribute('aria-sort', 'ascending');

    fireEvent.click(within(priceHeader()).getByRole('button'));
    await waitFor(() => expect(lastUrl()).toContain('sort=price&order=desc'));
    expect(priceHeader()).toHaveAttribute('aria-sort', 'descending');
  });

  test('Stock on hand and Last updated map to the API sort keys; Last updated starts newest first', async () => {
    fetch.mockImplementation(async () => reply(page([product()])));
    render(<InventoryPage debounceMs={5} />);
    await screen.findByText('Wireless Mouse');

    fireEvent.click(within(screen.getByRole('columnheader', { name: /Stock on hand/ })).getByRole('button'));
    await waitFor(() => expect(lastUrl()).toContain('sort=stockQuantity&order=asc'));

    fireEvent.click(within(screen.getByRole('columnheader', { name: /Last updated/ })).getByRole('button'));
    await waitFor(() => expect(lastUrl()).toContain('sort=updatedAt&order=desc'));
  });

  test('the Status column is not sortable', async () => {
    fetch.mockImplementation(async () => reply(page([product()])));
    render(<InventoryPage debounceMs={5} />);
    await screen.findByText('Wireless Mouse');
    expect(within(screen.getByRole('columnheader', { name: 'Status' })).queryByRole('button')).toBeNull();
  });
});

describe('pagination', () => {
  const sixty = (n) => reply(page([product()], { page: n, total: 60, totalPages: 3 }));

  test('shows the range, disables Previous on page 1, and moves between pages', async () => {
    fetch.mockImplementation(async (url) => sixty(Number(new URL(url, 'http://x').searchParams.get('page'))));
    render(<InventoryPage debounceMs={5} />);
    expect(await screen.findByText('Showing 1–25 of 60')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 26–50 of 60')).toBeInTheDocument();
    expect(lastUrl()).toContain('page=2');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 51–60 of 60')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText('Showing 26–50 of 60')).toBeInTheDocument();
  });

  test('searching returns to page 1', async () => {
    fetch.mockImplementation(async (url) => sixty(Number(new URL(url, 'http://x').searchParams.get('page'))));
    render(<InventoryPage debounceMs={5} />);
    await screen.findByText('Showing 1–25 of 60');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Showing 26–50 of 60');

    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'mouse' } });
    await waitFor(() => expect(lastUrl()).toContain('q=mouse'));
    expect(lastUrl()).toContain('page=1');
  });
});

describe('pagination: more cases', () => {
  const paged = (total) => async (url) => {
    const params = new URL(url, 'http://x').searchParams;
    const number = Number(params.get('page'));
    const size = Number(params.get('pageSize'));
    const count = Math.max(0, Math.min(size, total - (number - 1) * size));
    const items = Array.from({ length: count }, (_, k) => {
      const n = (number - 1) * size + k + 1;
      return product({ id: n, sku: `SKU-${n}` });
    });
    return reply({ items, page: number, pageSize: size, total, totalPages: Math.ceil(total / size) });
  };

  test('a single page disables both buttons', async () => {
    fetch.mockImplementation(paged(5));
    render(<InventoryPage debounceMs={5} />);
    await screen.findByText('Showing 1–5 of 5');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  test('walks through three pages and shows the right rows and ranges on each', async () => {
    fetch.mockImplementation(paged(60));
    render(<InventoryPage debounceMs={5} />);
    await screen.findByText('Showing 1–25 of 60');
    expect(screen.getAllByRole('row')).toHaveLength(26); // header + 25 rows
    expect(screen.getByText('SKU-1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Showing 26–50 of 60');
    expect(screen.getByText('SKU-26')).toBeInTheDocument();
    expect(screen.queryByText('SKU-1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Showing 51–60 of 60');
    expect(screen.getAllByRole('row')).toHaveLength(11); // header + 10 rows on the last page
    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await screen.findByText('Showing 26–50 of 60');
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
  });

  test('changing the sort order returns to page 1', async () => {
    fetch.mockImplementation(paged(60));
    render(<InventoryPage debounceMs={5} />);
    await screen.findByText('Showing 1–25 of 60');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Showing 26–50 of 60');

    fireEvent.click(within(screen.getByRole('columnheader', { name: /Price/ })).getByRole('button'));
    await screen.findByText('Showing 1–25 of 60');
    expect(lastUrl()).toContain('sort=price');
    expect(lastUrl()).toContain('page=1');
  });

  test('changing the status filter returns to page 1 and never requests a stale page number', async () => {
    fetch.mockImplementation(paged(60));
    render(<InventoryPage debounceMs={5} />);
    await screen.findByText('Showing 1–25 of 60');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Showing 26–50 of 60');

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'inactive' } });
    await screen.findByText('Showing 1–25 of 60');
    const statusRequests = urls().filter((u) => u.includes('status=inactive'));
    expect(statusRequests).toHaveLength(1);
    expect(statusRequests[0]).toContain('page=1');
  });

  test('a search that returns no results hides the pagination controls', async () => {
    fetch.mockImplementation(async (url) => (url.includes('q=nothing') ? reply(page([])) : paged(60)(url)));
    render(<InventoryPage debounceMs={5} />);
    await screen.findByText('Showing 1–25 of 60');

    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'nothing' } });
    await screen.findByText('No products match “nothing”.');
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  });

  test('the page buttons are disabled while the next page is loading', async () => {
    let release;
    fetch.mockImplementation(async (url) => {
      if (url.includes('page=2')) {
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return paged(60)(url);
    });
    render(<InventoryPage debounceMs={5} />);
    await screen.findByText('Showing 1–25 of 60');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

    release();
    await screen.findByText('Showing 26–50 of 60');
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });
});

describe('errors and session handling', () => {
  test('a network error shows a message and Try again recovers', async () => {
    fetch.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockImplementation(async () => reply(page([product()])));
    render(<InventoryPage debounceMs={5} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Wireless Mouse')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('a server error shows a generic message', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Internal server error' }, 500));
    render(<InventoryPage debounceMs={5} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Products could not be loaded');
  });

  test('a 401 tells the app the session has ended', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetch.mockImplementation(async () => reply({ error: 'Authentication required' }, 401));
    render(<InventoryPage debounceMs={5} />);
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
  });

  test('a slow old response cannot replace a newer one', async () => {
    let releaseOld;
    const oldReply = new Promise((resolve) => {
      releaseOld = resolve;
    });
    fetch.mockImplementation((url) =>
      url.includes('q=new') ? Promise.resolve(reply(page([product({ name: 'New Result' })]))) : oldReply
    );
    render(<InventoryPage debounceMs={5} />);

    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'new' } });
    expect(await screen.findByText('New Result')).toBeInTheDocument();

    releaseOld(reply(page([product({ name: 'Old Result' })])));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.getByText('New Result')).toBeInTheDocument();
    expect(screen.queryByText('Old Result')).not.toBeInTheDocument();
  });

  test('if the current page no longer exists (fewer results now), it moves back to the last real page', async () => {
    fetch.mockImplementation(async (url) => {
      const pageNumber = Number(new URL(url, 'http://x').searchParams.get('page'));
      if (pageNumber === 1 && !fetch.shrunk) return reply(page([product()], { total: 60, totalPages: 3 }));
      if (pageNumber === 1) return reply(page([product({ name: 'Back On Page One' })], { total: 25, totalPages: 1 }));
      fetch.shrunk = true; // by the time page 2 is requested, items were removed elsewhere
      return reply(page([], { page: pageNumber, total: 25, totalPages: 1 }));
    });
    render(<InventoryPage debounceMs={5} />);
    await screen.findByText('Wireless Mouse');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Back On Page One')).toBeInTheDocument();
    expect(lastUrl()).toContain('page=1');
  });

  test('a 200 reply without a product list shows an error instead of loading forever', async () => {
    fetch.mockImplementation(async () => new Response('not json', { status: 200 }));
    render(<InventoryPage debounceMs={5} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Products could not be loaded');
    expect(screen.queryByText('Loading products…')).not.toBeInTheDocument();
  });
});

describe('accessibility basics', () => {
  test('has labelled search and status controls and a table caption', async () => {
    fetch.mockImplementation(async () => reply(page([product()])));
    render(<InventoryPage debounceMs={5} />);
    await screen.findByText('Wireless Mouse');
    expect(screen.getByLabelText('Search products')).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Products' })).toBeInTheDocument();
  });
});
