// The create-order form with a fake fetch. Nothing here talks to a real server or database.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import OrderForm from './OrderForm.jsx';

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const page = (items) => ({ items, page: 1, pageSize: 100, total: items.length, totalPages: 1 });

const CUSTOMERS = [{ id: 3, name: 'Ann Lee', email: 'ann@example.com', isActive: true }];
const PRODUCTS = [
  { id: 5, sku: 'AAA-1', name: 'Widget', price: '10.50', stockQuantity: 4, isActive: true },
  { id: 6, sku: 'BBB-2', name: 'Gadget', price: '0.10', stockQuantity: 100, isActive: true },
];

let postHandler;

beforeEach(() => {
  postHandler = async () => reply({ order: { id: 1 } }, 201);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options = {}) => {
      if (options.method === 'POST') return postHandler(url, JSON.parse(options.body));
      if (String(url).startsWith('/api/customers')) return reply(page(CUSTOMERS));
      if (String(url).startsWith('/api/products')) return reply(page(PRODUCTS));
      throw new Error(`Unexpected request: ${url}`);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const posts = () => fetch.mock.calls.filter(([, options]) => options?.method === 'POST');

async function renderForm(props = {}) {
  const onCreated = vi.fn();
  const onCancel = vi.fn();
  render(<OrderForm onCreated={onCreated} onCancel={onCancel} {...props} />);
  await screen.findByLabelText(/Customer/);
  return { onCreated, onCancel };
}

function fillFirstLine({ customer = '3', product = '5', quantity = '2' } = {}) {
  fireEvent.change(screen.getByLabelText(/Customer/), { target: { value: customer } });
  fireEvent.change(screen.getByLabelText('Product 1'), { target: { value: product } });
  fireEvent.change(screen.getByLabelText(/^Quantity/), { target: { value: quantity } });
}

describe('loading', () => {
  test('requests only active customers and products and lists them', async () => {
    await renderForm();
    const urls = fetch.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.startsWith('/api/customers?') && u.includes('status=active'))).toBe(true);
    expect(urls.some((u) => u.startsWith('/api/products?') && u.includes('status=active'))).toBe(true);
    expect(screen.getByRole('option', { name: 'Ann Lee (ann@example.com)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /AAA-1 — Widget \(10.50\)/ })).toBeInTheDocument();
  });

  test('a failed load offers Try again and no way to submit', async () => {
    fetch.mockImplementation(async () => reply({ error: 'x' }, 500));
    render(<OrderForm onCreated={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByRole('button', { name: 'Create order' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('lines and totals', () => {
  test('the estimate follows quantities in whole cents and is labelled as an estimate', async () => {
    await renderForm();
    fillFirstLine({ quantity: '3' });
    expect(screen.getAllByText('31.50')).toHaveLength(2); // the line estimate and the total: 3 x 10.50
    fireEvent.click(screen.getByRole('button', { name: /Add another product/ }));
    fireEvent.change(screen.getByLabelText('Product 2'), { target: { value: '6' } });
    fireEvent.change(screen.getAllByLabelText(/^Quantity/)[1], { target: { value: '3' } });
    expect(screen.getByText('31.80')).toBeInTheDocument(); // + 3 x 0.10, no floating-point drift
    expect(screen.getByText(/Estimate only/)).toBeInTheDocument();
  });

  test('plus and minus change the quantity within 1 and the maximum', async () => {
    await renderForm();
    const qty = screen.getByLabelText(/^Quantity/);
    fireEvent.click(screen.getByRole('button', { name: 'Increase quantity for product 1' }));
    expect(qty).toHaveValue('2');
    fireEvent.click(screen.getByRole('button', { name: 'Decrease quantity for product 1' }));
    expect(qty).toHaveValue('1');
    expect(screen.getByRole('button', { name: 'Decrease quantity for product 1' })).toBeDisabled();
  });

  test('warns when the quantity is above current stock but still allows it', async () => {
    await renderForm();
    fillFirstLine({ quantity: '9' });
    expect(screen.getByText(/Only 4 in stock now/)).toBeInTheDocument();
  });

  test('lines can be removed, but the last one stays', async () => {
    await renderForm();
    expect(screen.getByRole('button', { name: 'Remove product 1' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Add another product/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove product 2' }));
    expect(screen.queryByLabelText('Product 2')).not.toBeInTheDocument();
  });
});

describe('validation', () => {
  test('an empty form shows errors and sends nothing', async () => {
    await renderForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create order' }));
    expect(await screen.findByText('Choose a customer.')).toBeInTheDocument();
    expect(screen.getByText('Choose a product.')).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  test.each(['0', '-2', '1.5', 'abc', '10001'])('quantity "%s" is rejected', async (quantity) => {
    await renderForm();
    fillFirstLine({ quantity });
    fireEvent.click(screen.getByRole('button', { name: 'Create order' }));
    expect(await screen.findByText(/Enter a whole number from 1 to 10,000/)).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  test('the same product twice is rejected', async () => {
    await renderForm();
    fillFirstLine();
    fireEvent.click(screen.getByRole('button', { name: /Add another product/ }));
    fireEvent.change(screen.getByLabelText('Product 2'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create order' }));
    expect(await screen.findByText(/already on the order/)).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
});

describe('submitting', () => {
  test('sends only ids and quantities and reports the result to the parent', async () => {
    const { onCreated } = await renderForm();
    fillFirstLine();
    fireEvent.click(screen.getByRole('button', { name: 'Create order' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(JSON.parse(posts()[0][1].body)).toEqual({ customerId: 3, items: [{ productId: 5, quantity: 2 }] });
    expect(onCreated.mock.calls[0][0]).toEqual({ order: { id: 1 }, partial: false });
  });

  test('is disabled while the request is in flight, and a double click sends one request', async () => {
    let finish;
    postHandler = () => new Promise((resolve) => (finish = () => resolve(reply({ order: { id: 1 } }, 201))));
    const { onCreated } = await renderForm();
    fillFirstLine();
    const submit = screen.getByRole('button', { name: 'Create order' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    const busy = await screen.findByRole('button', { name: 'Creating order…' });
    expect(busy).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(posts()).toHaveLength(1);
    finish();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  test('a partial success is handed to the parent as a saved order, with no error and no retry prompt', async () => {
    postHandler = async () =>
      reply({ order: null, orderId: 41, status: 'PENDING', totalAmount: '21.00', detailsAvailable: false, message: 'm' }, 201);
    const { onCreated } = await renderForm();
    fillFirstLine();
    fireEvent.click(screen.getByRole('button', { name: 'Create order' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated.mock.calls[0][0]).toEqual({
      order: null,
      partial: true,
      orderId: 41,
      status: 'PENDING',
      totalAmount: '21.00',
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('failures keep the form and its values', () => {
  async function submitWith(handler) {
    postHandler = handler;
    const { onCreated } = await renderForm();
    fillFirstLine();
    fireEvent.click(screen.getByRole('button', { name: 'Create order' }));
    await screen.findByRole('alert');
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^Quantity/)).toHaveValue('2');
    expect(screen.getByRole('button', { name: 'Create order' })).toBeEnabled();
  }

  test('409 inactive customer marks the customer field', async () => {
    await submitWith(async () => reply({ error: 'Customer is inactive', fields: ['customerId'] }, 409));
    expect(screen.getByText(/customer is inactive/i)).toBeInTheDocument();
  });

  test('409 inactive products marks the product line', async () => {
    await submitWith(async () => reply({ error: 'Some products are inactive', fields: ['items'], productIds: [5] }, 409));
    expect(screen.getByText(/server rejected this product/)).toBeInTheDocument();
  });

  test('503 says the order was not created', async () => {
    await submitWith(async () => reply({ error: 'busy' }, 503));
    expect(screen.getByRole('alert')).toHaveTextContent('order was not created');
  });

  test('a network error warns the order may exist and points to the list', async () => {
    await submitWith(async () => {
      throw new TypeError('offline');
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Check the Orders list before trying again');
  });
});
