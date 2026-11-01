// The dashboard with a fake fetch. Nothing here talks to a real server or database.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import DashboardPage from './DashboardPage.jsx';

vi.mock('../auth/AuthContext.jsx', () => ({ useAuth: () => ({ admin: { email: 'admin@example.com' } }) }));

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const makeProduct = (n, stockQuantity) => ({
  id: n,
  sku: `SKU-${n}`,
  name: `Product ${n}`,
  price: '1.00',
  stockQuantity,
  isActive: true,
});

const makeOrder = (n, overrides = {}) => ({
  id: n,
  status: 'PENDING',
  totalAmount: `${n}.50`,
  itemCount: 1,
  customer: { id: 1, name: `Customer ${n}`, email: `c${n}@example.com` },
  createdAt: '2026-10-27T10:00:00.000Z',
  updatedAt: '2026-10-27T10:00:00.000Z',
  ...overrides,
});

// The numbers the fake server reports. Tests change these (or add failures) before rendering.
let data;
let failing;

// The sort keys the real server accepts (server/src/validation/*Schemas.js). Anything else is a 400, as in production.
const ALLOWED_SORTS = {
  '/api/products': ['sku', 'name', 'price', 'stockQuantity', 'updatedAt'],
  '/api/customers': ['name', 'email', 'createdAt', 'updatedAt'],
  '/api/orders': ['id', 'createdAt', 'updatedAt', 'totalAmount', 'status', 'customerName'],
};

function handle(url) {
  const parsed = new URL(url, 'http://x');
  const params = parsed.searchParams;
  const key = parsed.pathname;
  if (key === '/api/settings') {
    if (failing.has('/api/settings')) return reply({ error: 'x' }, 500);
    return reply({
      settings: { lowStockThreshold: data.threshold },
      app: { name: 'ShelfSync', serverVersion: '0.1.0', clientVersion: '0.1.0', environment: 'development' },
    });
  }
  if (!ALLOWED_SORTS[key]?.includes(params.get('sort'))) return reply({ error: 'Invalid request', fields: ['sort'] }, 400);
  if (failing.has(key) || failing.has(`${key}?${params.get('status')}`)) return reply({ error: 'x' }, 500);

  if (key === '/api/customers') return reply({ items: [], page: 1, pageSize: 1, total: data.customers, totalPages: 1 });
  if (key === '/api/orders') {
    const status = params.get('status');
    const total = status === 'all' ? data.orderTotal : data.byStatus[status] ?? 0;
    const items = Number(params.get('pageSize')) > 1 ? data.recent : [];
    return reply({ items, page: 1, pageSize: Number(params.get('pageSize')), total, totalPages: 1 });
  }
  if (key === '/api/products') {
    if (params.get('status') === 'all') return reply({ items: [], page: 1, pageSize: 1, total: data.products, totalPages: 1 });
    const size = Number(params.get('pageSize'));
    const sorted = [...data.stocked].sort((a, b) => a.stockQuantity - b.stockQuantity);
    return reply({ items: sorted.slice(0, size), page: 1, pageSize: size, total: sorted.length, totalPages: 1 });
  }
  throw new Error(`Unexpected request: ${url}`);
}

beforeEach(() => {
  failing = new Set();
  data = {
    threshold: 5, // the saved low-stock threshold the fake /api/settings reports
    products: 42,
    customers: 17,
    orderTotal: 120,
    byStatus: { PENDING: 7, CONFIRMED: 20, SHIPPED: 13, DELIVERED: 70, CANCELLED: 10 },
    recent: [makeOrder(9), makeOrder(8, { status: 'CONFIRMED' })],
    stocked: [makeProduct(1, 0), makeProduct(2, 5), makeProduct(3, 6), makeProduct(4, 50)],
  };
  vi.stubGlobal('fetch', vi.fn(async (url) => handle(String(url))));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const urls = () => fetch.mock.calls.map(([url]) => String(url));

function renderDashboard() {
  const onNavigate = vi.fn();
  render(<DashboardPage onNavigate={onNavigate} />);
  return onNavigate;
}

const card = (label) => screen.getByText(label, { selector: '.stat-card__label' }).closest('.stat-card');

describe('summary cards', () => {
  test('show the totals reported by the API, not hardcoded numbers', async () => {
    renderDashboard();
    await waitFor(() => expect(within(card('Total products')).getByText('42')).toBeInTheDocument());
    expect(within(card('Total customers')).getByText('17')).toBeInTheDocument();
    expect(within(card('Total orders')).getByText('120')).toBeInTheDocument();
    expect(within(card('Pending orders')).getByText('7')).toBeInTheDocument();
  });

  test('every request uses a sort key the server accepts (the server answers 400 otherwise)', async () => {
    renderDashboard();
    await screen.findByText('Customer 9');
    await waitFor(() => expect(within(card('Total products')).getByText('42')).toBeInTheDocument());
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
    expect(urls()).toContain('/api/products?status=all&page=1&pageSize=1&sort=name&order=asc');
    expect(urls()).toContain('/api/customers?status=all&page=1&pageSize=1&sort=name&order=asc');
  });

  test('counts come from one-row pages, so they do not depend on the page size', async () => {
    renderDashboard();
    await screen.findByText('Customer 9');
    expect(urls()).toContain('/api/orders?status=PENDING&page=1&pageSize=1&sort=id&order=asc');
  });

  test('a real zero is shown as 0', async () => {
    data.customers = 0;
    renderDashboard();
    await waitFor(() => expect(within(card('Total customers')).getByText('0')).toBeInTheDocument());
  });

  test('a failed request shows Unavailable and a retry, never a zero', async () => {
    failing.add('/api/customers');
    renderDashboard();
    await waitFor(() => expect(within(card('Total customers')).getByText('Unavailable')).toBeInTheDocument());
    expect(within(card('Total customers')).queryByText('0')).not.toBeInTheDocument();
    // The other cards are not affected.
    await waitFor(() => expect(within(card('Total products')).getByText('42')).toBeInTheDocument());

    failing.clear();
    fireEvent.click(within(card('Total customers')).getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(within(card('Total customers')).getByText('17')).toBeInTheDocument());
  });

  test('a reply without a numeric total is treated as an error, not as zero', async () => {
    fetch.mockImplementation(async (url) =>
      String(url).startsWith('/api/customers') ? reply({ items: [] }) : handle(String(url))
    );
    renderDashboard();
    await waitFor(() => expect(within(card('Total customers')).getByText('Unavailable')).toBeInTheDocument());
  });
});

describe('orders by status', () => {
  test('shows a count for each of the five statuses', async () => {
    renderDashboard();
    const panel = (await screen.findByRole('heading', { name: 'Orders by status' })).closest('section');
    await waitFor(() => expect(within(panel).getByText('70')).toBeInTheDocument());
    for (const [label, count] of [
      ['Pending', '7'],
      ['Confirmed', '20'],
      ['Shipped', '13'],
      ['Delivered', '70'],
      ['Cancelled', '10'],
    ]) {
      expect(within(within(panel).getByText(label).closest('li')).getByText(count)).toBeInTheDocument();
    }
  });

  test('if any status count fails, the panel and the Pending card show errors instead of partial numbers', async () => {
    failing.add('/api/orders?SHIPPED');
    renderDashboard();
    expect(await screen.findByText('Order counts could not be loaded.')).toBeInTheDocument();
    expect(within(card('Pending orders')).getByText('Unavailable')).toBeInTheDocument();
  });
});

describe('low stock', () => {
  test('lists only products at or under the threshold of 5, lowest first, and labels the threshold', async () => {
    renderDashboard();
    const panel = (await screen.findByRole('heading', { name: 'Low stock' })).closest('section');
    await within(panel).findByText('Product 2');
    expect(within(panel).getByText(/5 or fewer in stock/)).toBeInTheDocument();
    expect(within(panel).getByText('Product 1')).toBeInTheDocument(); // stock 0 is low
    expect(within(panel).getByText('Out of stock')).toBeInTheDocument();
    expect(within(panel).getByText('Product 2')).toBeInTheDocument(); // stock 5 is low: the boundary is included
    expect(within(panel).queryByText('Product 3')).not.toBeInTheDocument(); // stock 6 is not
    expect(within(panel).queryByText('Product 4')).not.toBeInTheDocument();
    expect(within(panel).getByText('2', { selector: 'strong' })).toBeInTheDocument();
  });

  test('asks the server for active products sorted by stock, lowest first', async () => {
    renderDashboard();
    await screen.findByText('Product 2');
    expect(urls()).toContain('/api/products?status=active&page=1&pageSize=100&sort=stockQuantity&order=asc');
  });

  test('says so when nothing is low', async () => {
    data.stocked = [makeProduct(3, 6), makeProduct(4, 50)];
    renderDashboard();
    expect(await screen.findByText('No active products have 5 or fewer in stock.')).toBeInTheDocument();
  });

  test('when all 100 products fetched are low and more exist, the count is shown as a lower bound', async () => {
    data.stocked = Array.from({ length: 150 }, (_, i) => makeProduct(i + 1, 1));
    renderDashboard();
    const panel = (await screen.findByRole('heading', { name: 'Low stock' })).closest('section');
    expect(await within(panel).findByText('100+')).toBeInTheDocument();
    expect(within(panel).getByText(/exact number is not available/)).toBeInTheDocument();
    expect(within(panel).getAllByRole('row')).toHaveLength(1 + 8); // header + the 8 shown
  });

  test('an error shows a message and retry, not an empty list', async () => {
    failing.add('/api/products?active');
    renderDashboard();
    expect(await screen.findByText('Low-stock products could not be loaded.')).toBeInTheDocument();
    failing.clear();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Product 2')).toBeInTheDocument();
  });

  test('Open Inventory uses the existing navigation', async () => {
    const onNavigate = renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Inventory' }));
    expect(onNavigate).toHaveBeenCalledWith('inventory');
  });
});

describe('recent orders', () => {
  test('asks for the five newest and shows order, customer, date, status and total', async () => {
    renderDashboard();
    const row = (await screen.findByText('Customer 9')).closest('tr');
    expect(urls()).toContain('/api/orders?status=all&page=1&pageSize=5&sort=createdAt&order=desc');
    expect(within(row).getByText('#9')).toBeInTheDocument();
    expect(within(row).getByText('Pending')).toBeInTheDocument();
    expect(within(row).getByText('9.50')).toBeInTheDocument();
    expect(within(screen.getByText('Customer 8').closest('tr')).getByText('Confirmed')).toBeInTheDocument();
  });

  test('View opens that order through the existing navigation', async () => {
    const onNavigate = renderDashboard();
    fireEvent.click(await screen.findByRole('button', { name: 'View order #8' }));
    expect(onNavigate).toHaveBeenCalledWith('orders', '?order=8');
  });

  test('View all orders goes to the Orders section', async () => {
    const onNavigate = renderDashboard();
    fireEvent.click(screen.getByRole('button', { name: 'View all orders' }));
    expect(onNavigate).toHaveBeenCalledWith('orders');
  });

  test('shows an empty state when there are no orders', async () => {
    data.recent = [];
    data.orderTotal = 0;
    renderDashboard();
    expect(await screen.findByText('No orders have been created yet.')).toBeInTheDocument();
    await waitFor(() => expect(within(card('Total orders')).getByText('0')).toBeInTheDocument());
  });

  test('an error shows a message and retry, and the Total orders card says Unavailable', async () => {
    failing.add('/api/orders?all');
    renderDashboard();
    expect(await screen.findByText('Recent orders could not be loaded.')).toBeInTheDocument();
    expect(within(card('Total orders')).getByText('Unavailable')).toBeInTheDocument();
    failing.clear();
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]);
    expect(await screen.findByText('Customer 9')).toBeInTheDocument();
  });
});

test('shows a loading state before the data arrives', () => {
  fetch.mockImplementation(() => new Promise(() => {}));
  renderDashboard();
  expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  expect(screen.getByText('Loading Total products')).toBeInTheDocument();
});
