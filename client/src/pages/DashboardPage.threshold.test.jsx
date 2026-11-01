// The Dashboard's low-stock panel and the saved threshold, with a fake fetch. Nothing here talks to a real server.
// The threshold is never hardcoded: it is the number GET /api/settings reports, read each time the Dashboard opens.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import DashboardPage from './DashboardPage.jsx';
import * as dashboardModule from './DashboardPage.jsx';

vi.mock('../auth/AuthContext.jsx', () => ({ useAuth: () => ({ admin: { email: 'admin@example.com' } }) }));

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const product = (n, stockQuantity) => ({ id: n, sku: `SKU-${n}`, name: `Product ${n}`, price: '1.00', stockQuantity, isActive: true });

let threshold; // what the fake /api/settings reports (or a function returning a Response)
let stocks; // the stock of each active product on the fake server
let settingsGate; // when set, /api/settings waits for it

beforeEach(() => {
  threshold = 5;
  stocks = [0, 3, 5, 6, 12, 13, 50];
  settingsGate = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const parsed = new URL(String(url), 'http://x');
      const params = parsed.searchParams;
      if (parsed.pathname === '/api/settings') {
        if (settingsGate) await settingsGate;
        if (typeof threshold === 'function') return threshold();
        return reply({
          settings: { lowStockThreshold: threshold },
          app: { name: 'ShelfSync', serverVersion: '0.1.0', clientVersion: '0.1.0', environment: 'development' },
        });
      }
      if (parsed.pathname === '/api/products' && params.get('status') === 'active') {
        const sorted = stocks.map((s, i) => product(i + 1, s)).sort((a, b) => a.stockQuantity - b.stockQuantity);
        const size = Number(params.get('pageSize'));
        return reply({ items: sorted.slice(0, size), page: 1, pageSize: size, total: sorted.length, totalPages: 1 });
      }
      if (parsed.pathname === '/api/products' || parsed.pathname === '/api/customers') {
        return reply({ items: [], page: 1, pageSize: 1, total: 9, totalPages: 9 });
      }
      if (parsed.pathname === '/api/orders') {
        const size = Number(params.get('pageSize'));
        return reply({ items: [], page: 1, pageSize: size, total: 0, totalPages: 0 });
      }
      throw new Error(`Unexpected request: ${url}`);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const urls = () => fetch.mock.calls.map(([url]) => String(url));
const lowStockRequests = () => urls().filter((u) => u.startsWith('/api/products?') && u.includes('status=active'));
const panel = async () => (await screen.findByRole('heading', { name: 'Low stock' })).closest('section');

describe('the threshold comes from the Settings API', () => {
  test('the hardcoded threshold is gone from the Dashboard module', () => {
    expect(dashboardModule.LOW_STOCK_THRESHOLD).toBeUndefined();
  });

  test('asks the server for the saved threshold when it opens', async () => {
    render(<DashboardPage onNavigate={vi.fn()} />);
    await within(await panel()).findByText('Product 2');
    expect(urls()).toContain('/api/settings');
  });

  test('a threshold of 5 lists products with 5 or fewer, boundary included (the default behaviour)', async () => {
    render(<DashboardPage onNavigate={vi.fn()} />);
    const low = await panel();
    await within(low).findByText('Product 1');
    expect(within(low).getByText(/5 or fewer in stock/)).toBeInTheDocument();
    expect(within(low).getByText('3', { selector: 'strong' })).toBeInTheDocument(); // stocks 0, 3 and 5
    expect(within(low).queryByText(/SKU-4\b/)).not.toBeInTheDocument(); // stock 6
  });

  test.each([
    [6, 4, /6 or fewer/],
    [12, 5, /12 or fewer/],
    [13, 6, /13 or fewer/],
    [1000, 7, /1000 or fewer/],
  ])('a saved threshold of %i lists %i products and says so', async (value, count, label) => {
    threshold = value;
    render(<DashboardPage onNavigate={vi.fn()} />);
    const low = await panel();
    await within(low).findByText(label);
    expect(within(low).getByText(String(count), { selector: 'strong' })).toBeInTheDocument();
    expect(lowStockRequests()).toHaveLength(1);
  });

  test('a threshold of 0 lists only products that are out of stock', async () => {
    threshold = 0;
    render(<DashboardPage onNavigate={vi.fn()} />);
    const low = await panel();
    await within(low).findByText(/0 or fewer in stock/);
    expect(within(low).getByText('Out of stock')).toBeInTheDocument();
    expect(within(low).getByText('1', { selector: 'strong' })).toBeInTheDocument();
    expect(within(low).queryByText('Product 2')).not.toBeInTheDocument();
  });

  test('a threshold that no product meets shows the empty state with the real number in it', async () => {
    threshold = 0;
    stocks = [4, 9, 30];
    render(<DashboardPage onNavigate={vi.fn()} />);
    expect(await screen.findByText('No active products have 0 or fewer in stock.')).toBeInTheDocument();
  });

  test('the count is a lower bound when all 100 products fetched are low and more exist', async () => {
    threshold = 1000;
    stocks = Array.from({ length: 150 }, (_, i) => i);
    render(<DashboardPage onNavigate={vi.fn()} />);
    const low = await panel();
    expect(await within(low).findByText('100+')).toBeInTheDocument();
  });

  test('the threshold is read again every time the Dashboard opens, so a change made in Settings shows up', async () => {
    const first = render(<DashboardPage onNavigate={vi.fn()} />);
    let low = await panel();
    await within(low).findByText(/5 or fewer in stock/);
    first.unmount(); // the person leaves for Settings...

    threshold = 12; // ...and saves 12 there
    render(<DashboardPage onNavigate={vi.fn()} />);
    low = await panel();
    await within(low).findByText(/12 or fewer in stock/);
    expect(urls().filter((u) => u === '/api/settings')).toHaveLength(2);
    expect(within(low).getByText('5', { selector: 'strong' })).toBeInTheDocument();
  });
});

describe('loading and failure', () => {
  test('nothing is requested for low stock until the threshold is known, and the panel shows it is loading', async () => {
    let open;
    settingsGate = new Promise((resolve) => {
      open = resolve;
    });
    render(<DashboardPage onNavigate={vi.fn()} />);
    const low = await panel();
    expect(within(low).getByText('Loading…')).toBeInTheDocument();
    await waitFor(() => expect(urls().some((u) => u.startsWith('/api/orders'))).toBe(true)); // the other panels load meanwhile
    expect(lowStockRequests()).toHaveLength(0);
    open();
    await within(low).findByText('Product 1');
    expect(lowStockRequests()).toHaveLength(1);
  });

  test('if the threshold can not be loaded, the panel says so with a retry and shows no guessed list', async () => {
    threshold = () => reply({ error: 'x' }, 500);
    render(<DashboardPage onNavigate={vi.fn()} />);
    const low = await panel();
    expect(await within(low).findByText('The low-stock threshold could not be loaded, so low-stock products are not shown.')).toBeInTheDocument();
    expect(within(low).queryByRole('table')).not.toBeInTheDocument();
    expect(within(low).queryByText(/or fewer in stock/)).not.toBeInTheDocument();
    expect(lowStockRequests()).toHaveLength(0); // no fallback number was used to fetch or filter anything
  });

  test('Try again reloads the threshold, then the low-stock list', async () => {
    threshold = () => reply({ error: 'x' }, 500);
    render(<DashboardPage onNavigate={vi.fn()} />);
    const low = await panel();
    await within(low).findByText(/threshold could not be loaded/);
    threshold = 12;
    fireEvent.click(within(low).getByRole('button', { name: 'Try again' }));
    await within(low).findByText(/12 or fewer in stock/);
    expect(lowStockRequests()).toHaveLength(1);
  });

  test('a settings reply with a non-numeric threshold is treated as a failure, not as zero or five', async () => {
    threshold = () => reply({ settings: { lowStockThreshold: 'five' }, app: {} });
    render(<DashboardPage onNavigate={vi.fn()} />);
    const low = await panel();
    expect(await within(low).findByText(/threshold could not be loaded/)).toBeInTheDocument();
    expect(lowStockRequests()).toHaveLength(0);
  });

  test('a lost connection to settings is handled the same way', async () => {
    threshold = () => {
      throw new TypeError('offline');
    };
    render(<DashboardPage onNavigate={vi.fn()} />);
    expect(await within(await panel()).findByText(/threshold could not be loaded/)).toBeInTheDocument();
  });

  test('a failed threshold does not break the other panels or cards', async () => {
    threshold = () => reply({ error: 'x' }, 500);
    render(<DashboardPage onNavigate={vi.fn()} />);
    await within(await panel()).findByText(/threshold could not be loaded/);
    const card = screen.getByText('Total products', { selector: '.stat-card__label' }).closest('.stat-card');
    await waitFor(() => expect(within(card).getByText('9')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Orders by status' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recent orders' })).toBeInTheDocument();
  });

  test('a failed low-stock list (the products request) keeps the real threshold in view of the retry and reports the list error', async () => {
    const original = fetch.getMockImplementation();
    fetch.mockImplementation(async (url) => {
      if (String(url).startsWith('/api/products?') && String(url).includes('status=active')) return reply({ error: 'x' }, 500);
      return original(url);
    });
    render(<DashboardPage onNavigate={vi.fn()} />);
    expect(await within(await panel()).findByText('Low-stock products could not be loaded.')).toBeInTheDocument();
  });
});

test('Open Inventory still navigates with the existing navigation', async () => {
  const onNavigate = vi.fn();
  render(<DashboardPage onNavigate={onNavigate} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Inventory' }));
  expect(onNavigate).toHaveBeenCalledWith('inventory');
});
