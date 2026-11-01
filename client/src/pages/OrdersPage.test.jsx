// The Orders page with a fake fetch. Nothing here talks to a real server or database.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import OrdersPage from './OrdersPage.jsx';

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const makeSummary = (n, overrides = {}) => ({
  id: n,
  status: 'PENDING',
  totalAmount: `${n}.50`,
  itemCount: 2,
  customer: { id: 3, name: `Customer ${n}`, email: `c${n}@example.com` },
  createdAt: '2026-10-27T10:00:00.000Z',
  updatedAt: '2026-10-27T10:00:00.000Z',
  ...overrides,
});

let orders;
let postHandler;

function listBody(params) {
  const q = (params.get('q') || '').toLowerCase();
  const status = params.get('status');
  const matching = orders.filter(
    (o) => (status === 'all' || o.status === status) && (!q || o.customer.name.toLowerCase().includes(q) || `#${o.id}` === q)
  );
  const pageNumber = Number(params.get('page'));
  const size = Number(params.get('pageSize'));
  return {
    items: matching.slice((pageNumber - 1) * size, pageNumber * size),
    page: pageNumber,
    pageSize: size,
    total: matching.length,
    totalPages: Math.ceil(matching.length / size),
  };
}

beforeEach(() => {
  orders = [makeSummary(1), makeSummary(2, { status: 'CONFIRMED' })];
  postHandler = async () => reply({ error: 'unexpected' }, 500);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options = {}) => {
      const path = String(url);
      if (options.method === 'POST') return postHandler(path, JSON.parse(options.body));
      const parsed = new URL(path, 'http://x');
      if (parsed.pathname === '/api/orders') return reply(listBody(parsed.searchParams));
      if (parsed.pathname.startsWith('/api/orders/')) {
        const id = Number(parsed.pathname.split('/').pop());
        return reply({
          order: {
            ...orders.find((o) => o.id === id),
            items: [{ id: 1, productId: 5, sku: 'AAA-1', productName: 'Widget', quantity: 2, unitPrice: '1.00', lineTotal: '2.00' }],
            statusHistory: [],
            customer: { ...orders.find((o) => o.id === id).customer, isActive: true },
          },
        });
      }
      if (parsed.pathname === '/api/customers') {
        return reply({ items: [{ id: 3, name: 'Ann Lee', email: 'ann@example.com', isActive: true }], page: 1, pageSize: 100, total: 1, totalPages: 1 });
      }
      if (parsed.pathname === '/api/products') {
        return reply({
          items: [{ id: 5, sku: 'AAA-1', name: 'Widget', price: '10.00', stockQuantity: 9, isActive: true }],
          page: 1,
          pageSize: 100,
          total: 1,
          totalPages: 1,
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const listUrls = () => fetch.mock.calls.map(([url]) => String(url)).filter((u) => u.startsWith('/api/orders?'));

async function renderLoaded() {
  render(<OrdersPage debounceMs={5} />);
  await screen.findByText('Customer 1');
}

describe('list', () => {
  test('shows order number, customer, date, items, total and status, newest first by default', async () => {
    await renderLoaded();
    expect(listUrls()[0]).toBe('/api/orders?status=all&page=1&pageSize=25&sort=createdAt&order=desc');
    const row = screen.getByText('Customer 2').closest('tr');
    expect(within(row).getByText('#2')).toBeInTheDocument();
    expect(within(row).getByText('c2@example.com')).toBeInTheDocument();
    expect(within(row).getByText('2.50')).toBeInTheDocument();
    expect(within(row).getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('2 orders')).toBeInTheDocument();
  });

  test('searching and filtering by status go to the server and return to page 1', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('Search orders'), { target: { value: 'Customer 2' } });
    await waitFor(() => expect(listUrls().at(-1)).toContain('q=Customer+2'));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'CONFIRMED' } });
    await waitFor(() => expect(listUrls().at(-1)).toContain('status=CONFIRMED'));
    expect(listUrls().at(-1)).toContain('page=1');
  });

  test('clicking a sortable header sorts on the server', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Total' }));
    await waitFor(() => expect(listUrls().at(-1)).toContain('sort=totalAmount&order=desc'));
    fireEvent.click(screen.getByRole('button', { name: /^Total/ }));
    await waitFor(() => expect(listUrls().at(-1)).toContain('sort=totalAmount&order=asc'));
  });

  test('shows an empty state', async () => {
    orders = [];
    render(<OrdersPage debounceMs={5} />);
    expect(await screen.findByText(/No orders have been created yet/)).toBeInTheDocument();
  });

  test('shows an error state with Try again', async () => {
    fetch.mockImplementationOnce(async () => reply({ error: 'x' }, 500));
    render(<OrdersPage debounceMs={5} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Customer 1')).toBeInTheDocument();
  });
});

describe('order details', () => {
  test('View opens the details panel for that order', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'View order #2' }));
    expect(await screen.findByRole('heading', { name: 'Order #2' })).toBeInTheDocument();
    expect(await screen.findByText('Widget')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark as shipped' })).toBeInTheDocument();
  });
});

describe('opening an order from a link', () => {
  test('?order=2 opens the details of that order and then removes the query from the address', async () => {
    window.history.replaceState(null, '', '/orders?order=2');
    render(<OrdersPage debounceMs={5} />);
    expect(await screen.findByRole('heading', { name: 'Order #2' })).toBeInTheDocument();
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe('/orders');
  });

  test('an invalid order id in the link is ignored', async () => {
    window.history.replaceState(null, '', '/orders?order=abc');
    await renderLoaded();
    expect(screen.queryByRole('heading', { name: /^Order #/ })).not.toBeInTheDocument();
  });
});

describe('creating an order', () => {
  async function createFromForm() {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /Create Order/ }));
    await screen.findByLabelText(/Customer/);
    fireEvent.change(screen.getByLabelText(/Customer/), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Product 1'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create order' }));
  }

  test('a created order closes the form, shows a success message and reloads the list', async () => {
    postHandler = async () => {
      orders = [makeSummary(3), ...orders];
      return reply({ order: { ...makeSummary(3), customer: { id: 3, name: 'Ann Lee', email: 'ann@example.com', isActive: true }, items: [], statusHistory: [] } }, 201);
    };
    await createFromForm();
    expect(await screen.findByText(/Order #3 was created for Ann Lee/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Create order' })).not.toBeInTheDocument();
    expect(await screen.findByText('Customer 3')).toBeInTheDocument();
  });

  test('a partial success is shown as created, says not to create it again, and reloads the list', async () => {
    postHandler = async () => {
      orders = [makeSummary(9), ...orders];
      return reply({ order: null, orderId: 9, status: 'PENDING', totalAmount: '10.00', detailsAvailable: false, message: 'm' }, 201);
    };
    await createFromForm();
    const notice = await screen.findByText(/Order #9 was created/);
    expect(notice).toHaveTextContent('details could not be loaded');
    expect(notice).toHaveTextContent('do not create it again');
    expect(notice).toHaveTextContent('Find it in the list below');
    expect(screen.queryByRole('heading', { name: 'Create order' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create order' })).not.toBeInTheDocument();
    expect(await screen.findByText('Customer 9')).toBeInTheDocument();
  });
});
