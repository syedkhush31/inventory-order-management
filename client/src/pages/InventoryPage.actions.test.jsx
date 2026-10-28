// Row actions on the Inventory page (edit, adjust stock, deactivate / reactivate) with a fake fetch.
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

// A tiny fake server: lists `store` (filtered by status like the real one) and hands every write to `writeHandler`.
let store;
let writeHandler;

function installFakeServer() {
  fetch.mockImplementation(async (url, options = {}) => {
    if (options.method && options.method !== 'GET') return writeHandler(url, options.method, JSON.parse(options.body));
    const params = new URL(url, 'http://x').searchParams;
    const status = params.get('status');
    const items = store.filter((p) => status === 'all' || (status === 'inactive' ? !p.isActive : p.isActive));
    return reply({ items, page: 1, pageSize: 25, total: items.length, totalPages: items.length ? 1 : 0 });
  });
}

const writeCalls = () => fetch.mock.calls.filter(([, options]) => options && options.method && options.method !== 'GET');
const listCalls = () => fetch.mock.calls.filter(([, options]) => !options || !options.method || options.method === 'GET');

async function renderLoaded(initial = [makeProduct(1), makeProduct(2)]) {
  store = initial;
  installFakeServer();
  render(<InventoryPage debounceMs={5} />);
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

describe('row actions', () => {
  test('every row has Edit, Adjust stock and Deactivate buttons named after its SKU', async () => {
    await renderLoaded();
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();
    for (const sku of ['SKU-1', 'SKU-2']) {
      expect(screen.getByRole('button', { name: `Edit ${sku}` })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: `Adjust stock for ${sku}` })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: `Deactivate ${sku}` })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /^Reactivate/ })).not.toBeInTheDocument();
  });

  test('an inactive product offers Reactivate instead of Deactivate', async () => {
    await renderLoaded([makeProduct(2), makeProduct(1, { isActive: false })]);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'inactive' } });
    expect(await screen.findByRole('button', { name: 'Reactivate SKU-1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate SKU-1' })).not.toBeInTheDocument();
  });

  test('only one panel is open at a time', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Edit SKU-1' }));
    expect(screen.getByRole('heading', { name: 'Edit product' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Adjust stock for SKU-2' }));
    expect(screen.queryByRole('heading', { name: 'Edit product' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Adjust stock: SKU-2' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add Product/ }));
    expect(screen.queryByRole('heading', { name: /Adjust stock/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Add product' })).toBeInTheDocument();
  });
});

describe('editing a product', () => {
  test('opens pre-filled, saves, shows a confirmation and reloads the list from the server', async () => {
    await renderLoaded();
    writeHandler = async (url, method, body) => {
      store = store.map((p) => (p.id === 1 ? { ...p, ...body } : p));
      return reply({ product: store[0] });
    };

    fireEvent.click(screen.getByRole('button', { name: 'Edit SKU-1' }));
    expect(screen.getByLabelText(/^SKU/)).toHaveValue('SKU-1');
    fireEvent.change(screen.getByLabelText(/^Product name/), { target: { value: 'Renamed Product' } });
    const listsBefore = listCalls().length;
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/Product updated: SKU-1 — Renamed Product\./)).toBeInTheDocument();
    expect(await screen.findByRole('cell', { name: 'Renamed Product' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Edit product' })).not.toBeInTheDocument();
    expect(listCalls().length).toBeGreaterThan(listsBefore);
    expect(writeCalls()).toHaveLength(1);
    expect(writeCalls()[0][0]).toBe('/api/products/1');
    expect(writeCalls()[0][1].method).toBe('PATCH');
  });

  test('a failed save keeps the form open, shows the error and does not show a success message', async () => {
    await renderLoaded();
    writeHandler = async () => reply({ error: 'dup', fields: ['sku'] }, 409);
    fireEvent.click(screen.getByRole('button', { name: 'Edit SKU-1' }));
    fireEvent.change(screen.getByLabelText(/^SKU/), { target: { value: 'SKU-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/A product with this SKU already exists/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Edit product' })).toBeInTheDocument();
    expect(screen.queryByText(/Product updated/)).not.toBeInTheDocument();
  });

  test('Cancel closes the form without sending anything', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Edit SKU-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: 'Edit product' })).not.toBeInTheDocument();
    expect(writeCalls()).toHaveLength(0);
  });
});

describe('deactivating and reactivating', () => {
  test('Deactivate asks for confirmation first and sends nothing until confirmed', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate SKU-1' }));
    expect(screen.getByRole('heading', { name: 'Deactivate SKU-1?' })).toBeInTheDocument();
    expect(screen.getByText(/Nothing is deleted/)).toBeInTheDocument();
    expect(writeCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('heading', { name: /Deactivate SKU-1/ })).not.toBeInTheDocument();
    expect(writeCalls()).toHaveLength(0);
  });

  test('confirming deactivates, shows a message and the product leaves the Active list', async () => {
    await renderLoaded();
    writeHandler = async () => {
      store = store.map((p) => (p.id === 1 ? { ...p, isActive: false } : p));
      return reply({ product: store[0] });
    };
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate SKU-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate product' }));

    expect(await screen.findByText(/SKU-1 — Product 1 was deactivated\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('cell', { name: 'Product 1' })).not.toBeInTheDocument());
    expect(screen.getByRole('cell', { name: 'Product 2' })).toBeInTheDocument();
    expect(writeCalls()[0][0]).toBe('/api/products/1/deactivate');
    expect(writeCalls()[0][1].method).toBe('POST');
  });

  test('a failed deactivation shows an error, keeps the product and sends no success message', async () => {
    await renderLoaded();
    writeHandler = async () => reply({ error: 'Internal server error' }, 500);
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate SKU-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate product' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be deactivated');
    expect(screen.queryByText(/was deactivated/)).not.toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Product 1' })).toBeInTheDocument();
  });

  test('the confirm button is disabled while the request runs, so it cannot be sent twice', async () => {
    await renderLoaded();
    let finish;
    writeHandler = () => new Promise((resolve) => (finish = resolve));
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate SKU-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate product' }));

    const busy = await screen.findByRole('button', { name: 'Deactivating…' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(writeCalls()).toHaveLength(1);
    finish(reply({ product: makeProduct(1, { isActive: false }) }));
    await screen.findByText(/was deactivated/);
  });

  test('Reactivate needs no confirmation and works straight away', async () => {
    await renderLoaded([makeProduct(2), makeProduct(1, { isActive: false })]);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'inactive' } });
    writeHandler = async () => {
      store = store.map((p) => ({ ...p, isActive: true }));
      return reply({ product: store[1] });
    };
    fireEvent.click(await screen.findByRole('button', { name: 'Reactivate SKU-1' }));

    expect(await screen.findByText(/SKU-1 — Product 1 was reactivated\./)).toBeInTheDocument();
    expect(writeCalls()[0][0]).toBe('/api/products/1/reactivate');
  });

  test('a 404 explains the product is gone and refreshes the list', async () => {
    await renderLoaded();
    writeHandler = async () => reply({ error: 'Product not found' }, 404);
    const listsBefore = listCalls().length;
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate SKU-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate product' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('no longer exists');
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(listsBefore));
  });
});

describe('adjusting stock', () => {
  test('saves a correction, shows the new stock and reloads the list', async () => {
    await renderLoaded();
    writeHandler = async (url, method, body) => {
      store = store.map((p) => (p.id === 1 ? { ...p, stockQuantity: p.stockQuantity + body.delta } : p));
      return reply(
        {
          product: store[0],
          adjustment: { id: 1, productId: 1, quantityDelta: body.delta, reason: body.reason, adminId: 7, createdAt: 'x' },
        },
        201
      );
    };

    fireEvent.click(screen.getByRole('button', { name: 'Adjust stock for SKU-1' }));
    fireEvent.change(screen.getByLabelText(/^Change in stock/), { target: { value: '-3' } });
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Damaged in storage' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    expect(await screen.findByText(/Stock corrected for SKU-1: -3\. Stock on hand is now 2\./)).toBeInTheDocument();
    const row = (await screen.findByRole('cell', { name: 'Product 1' })).closest('tr');
    await waitFor(() => expect(within(row).getByText('2')).toBeInTheDocument());
    expect(writeCalls()[0][0]).toBe('/api/products/1/stock-adjustments');
    expect(JSON.parse(writeCalls()[0][1].body)).toEqual({ delta: -3, reason: 'Damaged in storage' });
    expect(screen.queryByRole('heading', { name: /Adjust stock/ })).not.toBeInTheDocument();
  });

  test('a correction that would go below zero is blocked in the browser and nothing is sent', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Adjust stock for SKU-1' }));
    fireEvent.change(screen.getByLabelText(/^Change in stock/), { target: { value: '-6' } });
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Recount' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    expect(screen.getByText('Stock cannot go below 0. Only 5 on hand.')).toBeInTheDocument();
    expect(writeCalls()).toHaveLength(0);
  });

  test('a server refusal keeps the form open and shows no success message', async () => {
    await renderLoaded();
    writeHandler = async () => reply({ error: 'x', fields: ['delta'], currentStock: 1 }, 409);
    fireEvent.click(screen.getByRole('button', { name: 'Adjust stock for SKU-1' }));
    fireEvent.change(screen.getByLabelText(/^Change in stock/), { target: { value: '-2' } });
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Recount' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    expect(await screen.findByText(/There are 1 on hand right now/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Adjust stock: SKU-1' })).toBeInTheDocument();
    expect(screen.queryByText(/Stock corrected/)).not.toBeInTheDocument();
  });
});
