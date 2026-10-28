// The Customers page with a fake fetch. Nothing here talks to a real server or database, so these tests do not
// prove live saving works.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import CustomersPage from './CustomersPage.jsx';
import { setUnauthorizedHandler } from '../api/client.js';

const makeCustomer = (n, overrides = {}) => ({
  id: n,
  name: `Customer ${n}`,
  email: `customer${n}@example.com`,
  phone: n % 2 ? `555 010${n}` : null,
  address: n % 2 ? `${n} Main St` : null,
  isActive: true,
  createdAt: '2026-10-27T10:00:00.000Z',
  updatedAt: '2026-10-27T10:00:00.000Z',
  ...overrides,
});

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// A tiny fake server: filters `store` like the real one (search, status), pages it 25 at a time, and hands every
// write to `writeHandler`.
let store;
let writeHandler;

function installFakeServer() {
  fetch.mockImplementation(async (url, options = {}) => {
    if (options.method && options.method !== 'GET') return writeHandler(url, options.method, JSON.parse(options.body));
    const params = new URL(url, 'http://x').searchParams;
    const q = (params.get('q') || '').toLowerCase();
    const status = params.get('status');
    const matching = store.filter(
      (c) =>
        (status === 'all' || (status === 'inactive' ? !c.isActive : c.isActive)) &&
        (!q || c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))
    );
    const pageNumber = Number(params.get('page'));
    const size = Number(params.get('pageSize'));
    return reply({
      items: matching.slice((pageNumber - 1) * size, pageNumber * size),
      page: pageNumber,
      pageSize: size,
      total: matching.length,
      totalPages: Math.ceil(matching.length / size),
    });
  });
}

const listCalls = () => fetch.mock.calls.filter(([, options]) => !options || !options.method || options.method === 'GET');
const writeCalls = () => fetch.mock.calls.filter(([, options]) => options && options.method && options.method !== 'GET');
const lastListUrl = () => listCalls().at(-1)[0];

async function renderLoaded(initial = [makeCustomer(1), makeCustomer(2)]) {
  store = initial;
  installFakeServer();
  render(<CustomersPage debounceMs={5} />);
  await screen.findByText(initial[0].name);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  writeHandler = async () => reply({ error: 'unexpected write' }, 500);
});

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

describe('the list', () => {
  test('shows a loading state, then a table with the customers and their details', async () => {
    store = [makeCustomer(1), makeCustomer(2)];
    installFakeServer();
    render(<CustomersPage debounceMs={5} />);
    expect(screen.getByText('Loading customers…')).toBeInTheDocument();

    expect(await screen.findByRole('table', { name: 'Customers' })).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent.replace(/[▲▼]/g, ''))).toEqual([
      'Name',
      'Email',
      'Phone',
      'Address',
      'Status',
      'Last updated',
      'Actions',
    ]);
    const row = screen.getByRole('cell', { name: 'Customer 1' }).closest('tr');
    expect(within(row).getByText('customer1@example.com')).toBeInTheDocument();
    expect(within(row).getByText('555 0101')).toBeInTheDocument();
    expect(within(row).getByText('1 Main St')).toBeInTheDocument();
    expect(within(row).getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('2 customers')).toBeInTheDocument();
    expect(lastListUrl()).toBe('/api/customers?status=active&page=1&pageSize=25&sort=name&order=asc');
    expect(listCalls()[0][1].credentials).toBe('include');
  });

  test('shows a dash for a missing phone or address', async () => {
    await renderLoaded([makeCustomer(2)]);
    const row = screen.getByRole('cell', { name: 'Customer 2' }).closest('tr');
    expect(within(row).getAllByText('—')).toHaveLength(2);
  });

  test('shows the empty state when there are no customers, with a hint to add one', async () => {
    store = [];
    installFakeServer();
    render(<CustomersPage debounceMs={5} />);
    expect(await screen.findByText(/There are no active customers yet/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  test('shows an error with a working Try again button', async () => {
    fetch.mockImplementationOnce(async () => reply({ error: 'Internal server error' }, 500));
    render(<CustomersPage debounceMs={5} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Customers could not be loaded. Please try again.');

    store = [makeCustomer(1)];
    installFakeServer();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Customer 1')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('a network failure says the server cannot be reached', async () => {
    fetch.mockImplementation(async () => {
      throw new TypeError('failed');
    });
    render(<CustomersPage debounceMs={5} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server');
  });

  test('a 200 reply without a list does not leave the page loading forever', async () => {
    fetch.mockImplementation(async () => reply({}));
    render(<CustomersPage debounceMs={5} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
  });

  test('a 401 tells the app to return to the login page', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetch.mockImplementation(async () => reply({ error: 'Authentication required' }, 401));
    render(<CustomersPage debounceMs={5} />);
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('search, filter, sort and pagination', () => {
  test('searching sends the trimmed text, resets to page 1 and shows matches', async () => {
    await renderLoaded([makeCustomer(1), makeCustomer(2)]);
    fireEvent.change(screen.getByLabelText('Search customers'), { target: { value: '  customer2 ' } });
    await waitFor(() => expect(lastListUrl()).toContain('q=customer2'));
    expect(await screen.findByText('1 customer')).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Customer 1' })).not.toBeInTheDocument();
  });

  test('a search with no matches names the search and offers Clear search', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('Search customers'), { target: { value: 'zzz' } });
    expect(await screen.findByText('No customers match “zzz”.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('Customer 1')).toBeInTheDocument();
  });

  test('the status filter requests inactive customers', async () => {
    await renderLoaded([makeCustomer(1), makeCustomer(2, { isActive: false })]);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'inactive' } });
    expect(await screen.findByRole('cell', { name: 'Customer 2' })).toBeInTheDocument();
    expect(lastListUrl()).toContain('status=inactive');
    expect(within(screen.getByRole('table')).getByText('Inactive')).toBeInTheDocument();
  });

  test('clicking a sortable header sorts, and clicking again reverses', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: /^Email/ }));
    await waitFor(() => expect(lastListUrl()).toContain('sort=email&order=asc'));
    fireEvent.click(screen.getByRole('button', { name: /^Email/ }));
    await waitFor(() => expect(lastListUrl()).toContain('sort=email&order=desc'));
    expect(screen.getByRole('columnheader', { name: /Email/ })).toHaveAttribute('aria-sort', 'descending');
  });

  test('moves between pages by requesting each page from the server', async () => {
    const many = Array.from({ length: 30 }, (_, i) => makeCustomer(i + 1));
    await renderLoaded(many);
    expect(screen.getByText('Showing 1–25 of 30')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 26–30 of 30')).toBeInTheDocument();
    expect(lastListUrl()).toContain('page=2');
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
});

describe('adding a customer', () => {
  test('the + Add Customer button opens the form, Cancel closes it and nothing is sent', async () => {
    await renderLoaded();
    const button = screen.getByRole('button', { name: /Add Customer/ });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(screen.getByRole('heading', { name: 'Add customer' })).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Add customer' })).not.toBeInTheDocument();
    expect(writeCalls()).toHaveLength(0);
  });

  test('saving shows a confirmation, closes the form and reloads the list from the server', async () => {
    await renderLoaded();
    writeHandler = async (url, method, body) => {
      const created = makeCustomer(3, { ...body });
      store = [...store, created];
      return reply({ customer: created }, 201);
    };
    fireEvent.click(screen.getByRole('button', { name: /Add Customer/ }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Brand New' } });
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'NEW@Example.com' } });
    const listsBefore = listCalls().length;
    fireEvent.click(screen.getByRole('button', { name: 'Add customer' }));

    expect(await screen.findByText(/Customer created: Brand New \(new@example\.com\)\./)).toBeInTheDocument();
    expect(await screen.findByRole('cell', { name: 'Brand New' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Add customer' })).not.toBeInTheDocument();
    expect(listCalls().length).toBeGreaterThan(listsBefore);
    expect(writeCalls()).toHaveLength(1);
    expect(writeCalls()[0][0]).toBe('/api/customers');
  });

  test('a duplicate email keeps the form open and shows no success message', async () => {
    await renderLoaded();
    writeHandler = async () => reply({ error: 'dup', fields: ['email'] }, 409);
    fireEvent.click(screen.getByRole('button', { name: /Add Customer/ }));
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Dup' } });
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'customer1@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add customer' }));

    expect(await screen.findByText(/A customer with this email already exists/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add customer' })).toBeInTheDocument();
    expect(screen.queryByText(/Customer created/)).not.toBeInTheDocument();
  });
});

describe('editing a customer', () => {
  test('opens pre-filled, saves only the change, shows a confirmation and reloads', async () => {
    await renderLoaded();
    writeHandler = async (url, method, body) => {
      store = store.map((c) => (c.id === 1 ? { ...c, ...body } : c));
      return reply({ customer: store[0] });
    };
    fireEvent.click(screen.getByRole('button', { name: 'Edit Customer 1' }));
    expect(screen.getByLabelText(/^Email/)).toHaveValue('customer1@example.com');
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Renamed Customer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/Customer updated: Renamed Customer/)).toBeInTheDocument();
    expect(await screen.findByRole('cell', { name: 'Renamed Customer' })).toBeInTheDocument();
    expect(writeCalls()[0][0]).toBe('/api/customers/1');
    expect(writeCalls()[0][1].method).toBe('PATCH');
    expect(JSON.parse(writeCalls()[0][1].body)).toEqual({ name: 'Renamed Customer' });
  });

  test('only one panel is open at a time', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Customer 1' }));
    expect(screen.getByRole('heading', { name: 'Edit customer' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add Customer/ }));
    expect(screen.queryByRole('heading', { name: 'Edit customer' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add customer' })).toBeInTheDocument();
  });
});

describe('deactivating and reactivating', () => {
  test('Deactivate asks for confirmation first and sends nothing until confirmed', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate Customer 1' }));
    expect(screen.getByRole('heading', { name: 'Deactivate Customer 1?' })).toBeInTheDocument();
    expect(screen.getByText(/Nothing is deleted/)).toBeInTheDocument();
    expect(writeCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: /Deactivate Customer 1/ })).not.toBeInTheDocument();
    expect(writeCalls()).toHaveLength(0);
  });

  test('confirming deactivates, shows a message and the customer leaves the Active list', async () => {
    await renderLoaded();
    writeHandler = async () => {
      store = store.map((c) => (c.id === 1 ? { ...c, isActive: false } : c));
      return reply({ customer: store[0] });
    };
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate Customer 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate customer' }));

    expect(await screen.findByText('Customer 1 was deactivated.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('cell', { name: 'Customer 1' })).not.toBeInTheDocument());
    expect(screen.getByRole('cell', { name: 'Customer 2' })).toBeInTheDocument();
    expect(writeCalls()[0][0]).toBe('/api/customers/1/deactivate');
    expect(writeCalls()[0][1].method).toBe('POST');
  });

  test('a failed deactivation shows an error and no success message', async () => {
    await renderLoaded();
    writeHandler = async () => reply({ error: 'Internal server error' }, 500);
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate Customer 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate customer' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be deactivated');
    expect(screen.queryByText(/was deactivated/)).not.toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Customer 1' })).toBeInTheDocument();
  });

  test('the confirm button is disabled while the request runs, so it cannot be sent twice', async () => {
    await renderLoaded();
    let finish;
    writeHandler = () => new Promise((resolve) => (finish = resolve));
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate Customer 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate customer' }));

    const busy = await screen.findByRole('button', { name: 'Deactivating…' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(writeCalls()).toHaveLength(1);
    finish(reply({ customer: makeCustomer(1, { isActive: false }) }));
    await screen.findByText(/was deactivated/);
  });

  test('Reactivate needs no confirmation and works straight away', async () => {
    await renderLoaded([makeCustomer(2), makeCustomer(1, { isActive: false })]);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'inactive' } });
    writeHandler = async () => {
      store = store.map((c) => ({ ...c, isActive: true }));
      return reply({ customer: store[1] });
    };
    fireEvent.click(await screen.findByRole('button', { name: 'Reactivate Customer 1' }));

    expect(await screen.findByText('Customer 1 was reactivated.')).toBeInTheDocument();
    expect(writeCalls()[0][0]).toBe('/api/customers/1/reactivate');
  });

  test('a 404 explains the customer is gone and refreshes the list', async () => {
    await renderLoaded();
    writeHandler = async () => reply({ error: 'Customer not found' }, 404);
    const listsBefore = listCalls().length;
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate Customer 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate customer' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('no longer exists');
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(listsBefore));
  });

  test('there is no Delete button anywhere', async () => {
    await renderLoaded();
    expect(screen.queryByRole('button', { name: /delete|remove/i })).not.toBeInTheDocument();
  });
});
