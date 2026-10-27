// The "+ Add Product" feature inside the Inventory page, with a fake fetch.
// Nothing here talks to a real server or database, so these tests do not prove live saving works.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import InventoryPage from './InventoryPage.jsx';
import { setUnauthorizedHandler } from '../api/client.js';

const makeProduct = (n, overrides = {}) => ({
  id: n,
  sku: `SKU-${n}`,
  name: `Product ${n}`,
  price: '10.00',
  stockQuantity: 5,
  isActive: true,
  createdAt: '2026-10-27T10:00:00.000Z',
  updatedAt: '2026-10-27T10:00:00.000Z',
  ...overrides,
});

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// A tiny fake server: lists whatever is in `store`, 25 per page, and handles POST.
let store;
let postHandler;

function installFakeServer() {
  fetch.mockImplementation(async (url, options = {}) => {
    if (options.method === 'POST') return postHandler(JSON.parse(options.body));
    const params = new URL(url, 'http://x').searchParams;
    const pageNumber = Number(params.get('page'));
    const size = Number(params.get('pageSize'));
    const items = store.slice((pageNumber - 1) * size, pageNumber * size);
    return reply({ items, page: pageNumber, pageSize: size, total: store.length, totalPages: Math.ceil(store.length / size) });
  });
}

const getCalls = () => fetch.mock.calls.filter(([, options]) => !options || !options.method || options.method === 'GET');
const postCalls = () => fetch.mock.calls.filter(([, options]) => options && options.method === 'POST');
const lastGetUrl = () => getCalls().at(-1)[0];

const addButton = () => screen.getByRole('button', { name: /Add Product/ });
const formSubmit = () => screen.getByRole('button', { name: 'Add product' });

function fillForm({ s = 'SKU-NEW', n = 'Brand New Item', p = '12.50', q = '8' } = {}) {
  fireEvent.change(screen.getByLabelText(/^SKU/), { target: { value: s } });
  fireEvent.change(screen.getByLabelText(/^Product name/), { target: { value: n } });
  fireEvent.change(screen.getByLabelText(/^Price/), { target: { value: p } });
  fireEvent.change(screen.getByLabelText(/^Initial stock quantity/), { target: { value: q } });
}

async function renderLoaded(initial = [makeProduct(1), makeProduct(2)]) {
  store = initial;
  installFakeServer();
  render(<InventoryPage debounceMs={5} />);
  await screen.findByText(`Product ${initial[0].id}`);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  postHandler = async () => reply({ error: 'unexpected POST' }, 500);
});

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

describe('the + Add Product button and inline form', () => {
  test('a clearly visible button sits in the page header, next to the title, above the table', async () => {
    await renderLoaded();
    const button = addButton();
    expect(button).toHaveTextContent('+ Add Product');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    const heading = screen.getByRole('heading', { name: 'Inventory' });
    expect(heading.parentElement.parentElement).toContainElement(button); // same header row
    expect(button.compareDocumentPosition(screen.getByRole('table')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('the form is hidden at first and opens inline without leaving the page or fetching anything', async () => {
    await renderLoaded();
    expect(screen.queryByRole('heading', { name: 'Add product' })).not.toBeInTheDocument();
    const before = fetch.mock.calls.length;

    fireEvent.click(addButton());
    expect(screen.getByRole('heading', { name: 'Add product' })).toBeInTheDocument();
    expect(addButton()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText(/^SKU/)).toHaveFocus();
    // The inventory list is still on screen below the form.
    expect(screen.getByRole('heading', { name: 'Inventory' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Products' })).toBeInTheDocument();
    expect(fetch.mock.calls.length).toBe(before);
  });

  test('Cancel closes the form without submitting and returns focus to the button', async () => {
    await renderLoaded();
    fireEvent.click(addButton());
    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('heading', { name: 'Add product' })).not.toBeInTheDocument();
    expect(addButton()).toHaveFocus();
    expect(addButton()).toHaveAttribute('aria-expanded', 'false');
    expect(postCalls()).toHaveLength(0);

    fireEvent.click(addButton());
    expect(screen.getByLabelText(/^SKU/)).toHaveValue(''); // a reopened form starts empty
  });
});

describe('successful creation', () => {
  test('saves, closes the form, confirms with the SKU and name, and shows the new product after a reload', async () => {
    await renderLoaded();
    postHandler = async (body) => {
      const saved = makeProduct(3, { sku: body.sku, name: body.name, price: body.price, stockQuantity: body.stockQuantity });
      store = [...store, saved];
      return reply({ product: saved }, 201);
    };

    fireEvent.click(addButton());
    fillForm();
    fireEvent.click(formSubmit());

    const banner = (await screen.findByText(/Product created:/)).closest('.banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(within(banner).getByText('SKU-NEW')).toBeInTheDocument();
    expect(banner).toHaveTextContent('Brand New Item');
    expect(screen.queryByRole('heading', { name: 'Add product' })).not.toBeInTheDocument();

    // The reloaded list now contains the saved product.
    expect(await within(screen.getByRole('table')).findByText('Brand New Item')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('SKU-NEW')).toBeInTheDocument();
    expect(postCalls()).toHaveLength(1);
    expect(JSON.parse(postCalls()[0][1].body)).toEqual({ sku: 'SKU-NEW', name: 'Brand New Item', price: '12.50', stockQuantity: 8 });
  });

  test('reloads from page 1 while keeping the search, status and sort, with only one list request', async () => {
    const many = Array.from({ length: 60 }, (_, i) => makeProduct(i + 1));
    await renderLoaded(many);

    // Choose some filters and go to page 2.
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } });
    await waitFor(() => expect(lastGetUrl()).toContain('status=all'));
    fireEvent.click(within(screen.getByRole('columnheader', { name: /Price/ })).getByRole('button'));
    await waitFor(() => expect(lastGetUrl()).toContain('sort=price&order=asc'));
    await screen.findByText('Showing 1–25 of 60');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Showing 26–50 of 60');
    expect(lastGetUrl()).toContain('page=2');

    postHandler = async (body) => reply({ product: makeProduct(99, { sku: body.sku, name: body.name }) }, 201);
    const listCallsBefore = getCalls().length;

    fireEvent.click(addButton());
    fillForm();
    fireEvent.click(formSubmit());
    await screen.findByText(/Product created:/);

    await waitFor(() => expect(getCalls().length).toBe(listCallsBefore + 1));
    expect(lastGetUrl()).toContain('page=1');
    expect(lastGetUrl()).toContain('status=all');
    expect(lastGetUrl()).toContain('sort=price&order=asc');
    await screen.findByText('Showing 1–25 of 60');
    expect(screen.getByLabelText('Status')).toHaveValue('all'); // filters are not silently cleared
  });

  test('keeps an active search and explains that the new product may be hidden by it', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'Product 1' } });
    await waitFor(() => expect(lastGetUrl()).toContain('q=Product+1'));

    postHandler = async (body) => reply({ product: makeProduct(50, { sku: body.sku, name: body.name }) }, 201);
    fireEvent.click(addButton());
    fillForm({ s: 'ZZZ-1', n: 'Unrelated Gadget' });
    fireEvent.click(formSubmit());

    const banner = (await screen.findByText(/Product created:/)).closest('.banner');
    expect(banner).toHaveTextContent('may be on another page or hidden by a filter');
    expect(screen.getByLabelText('Search products')).toHaveValue('Product 1');
    await waitFor(() => expect(lastGetUrl()).toContain('q=Product+1'));
  });

  test('the confirmation can be dismissed, and opening the form again removes it', async () => {
    await renderLoaded();
    postHandler = async (body) => reply({ product: makeProduct(7, { sku: body.sku, name: body.name }) }, 201);

    fireEvent.click(addButton());
    fillForm();
    fireEvent.click(formSubmit());
    await screen.findByText(/Product created:/);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/Product created:/)).not.toBeInTheDocument();

    fireEvent.click(addButton());
    fillForm({ s: 'SKU-2', n: 'Second' });
    fireEvent.click(formSubmit());
    await screen.findByText(/Product created:/);
    fireEvent.click(addButton());
    expect(screen.queryByText(/Product created:/)).not.toBeInTheDocument();
  });
});

describe('failures never look like successes', () => {
  test('a duplicate SKU keeps the form open with the error beside the SKU field, and does not reload the list', async () => {
    await renderLoaded();
    postHandler = async () => reply({ error: 'A product with this SKU already exists', fields: ['sku'] }, 409);
    const listCallsBefore = getCalls().length;

    fireEvent.click(addButton());
    fillForm({ s: 'SKU-1' });
    fireEvent.click(formSubmit());

    expect(await screen.findByText('A product with this SKU already exists. Choose a different SKU.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add product' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^SKU/)).toHaveFocus();
    expect(screen.queryByText(/Product created:/)).not.toBeInTheDocument();
    expect(getCalls().length).toBe(listCallsBefore);
  });

  test('a network failure shows an error and no success message', async () => {
    await renderLoaded();
    postHandler = async () => {
      throw new TypeError('Failed to fetch');
    };
    fireEvent.click(addButton());
    fillForm();
    fireEvent.click(formSubmit());

    expect(await screen.findByText(/Cannot reach the server, so the product may not have been saved/)).toBeInTheDocument();
    expect(screen.queryByText(/Product created:/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^SKU/)).toHaveValue('SKU-NEW');
  });

  test('an invalid form is stopped in the browser: nothing is sent and no success is shown', async () => {
    await renderLoaded();
    fireEvent.click(addButton());
    fireEvent.click(formSubmit());
    expect(screen.getByText('Enter a SKU.')).toBeInTheDocument();
    expect(postCalls()).toHaveLength(0);
    expect(screen.queryByText(/Product created:/)).not.toBeInTheDocument();
  });

  test('a second submit while saving sends only one request', async () => {
    await renderLoaded();
    let finish;
    postHandler = () =>
      new Promise((resolve) => {
        finish = () => resolve(reply({ product: makeProduct(8, { sku: 'SKU-NEW', name: 'Brand New Item' }) }, 201));
      });
    fireEvent.click(addButton());
    fillForm();
    fireEvent.click(formSubmit());
    const saving = await screen.findByRole('button', { name: 'Saving…' });
    fireEvent.click(saving);
    fireEvent.submit(saving.closest('form'));
    expect(postCalls()).toHaveLength(1);

    finish();
    await screen.findByText(/Product created:/);
    expect(postCalls()).toHaveLength(1);
  });

  test('session expiry during a save sends the app back to login and shows no success', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    await renderLoaded();
    postHandler = async () => reply({ error: 'Authentication required' }, 401);
    const listCallsBefore = getCalls().length;

    fireEvent.click(addButton());
    fillForm();
    fireEvent.click(formSubmit());

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Product created:/)).not.toBeInTheDocument();
    expect(getCalls().length).toBe(listCallsBefore);
  });
});

describe('existing inventory behaviour is unchanged by the new form', () => {
  test('search, status, sort and pagination controls are all still present', async () => {
    await renderLoaded([makeProduct(1)]);
    fireEvent.click(addButton()); // even with the form open
    expect(screen.getByLabelText('Search products')).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Price/ })).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByText('Showing 1–1 of 1')).toBeInTheDocument();
  });
});
