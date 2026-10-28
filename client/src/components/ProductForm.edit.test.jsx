// The Edit product form (ProductForm with a `product`), with a fake fetch: no backend or database is involved.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProductForm from './ProductForm.jsx';
import { setUnauthorizedHandler } from '../api/client.js';

const PRODUCT = {
  id: 9,
  sku: 'SKU-9',
  name: 'USB Hub',
  price: '24.50',
  stockQuantity: 15,
  isActive: true,
  createdAt: '2026-10-28T09:00:00.000Z',
  updatedAt: '2026-10-28T09:00:00.000Z',
};

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const sku = () => screen.getByLabelText(/^SKU/);
const productName = () => screen.getByLabelText(/^Product name/);
const price = () => screen.getByLabelText(/^Price/);
const save = () => screen.getByRole('button', { name: 'Save changes' });

function setup(product = PRODUCT) {
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  render(<ProductForm product={product} onSaved={onSaved} onCancel={onCancel} />);
  return { onSaved, onCancel };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

describe('layout', () => {
  test('is titled Edit product, pre-filled, and has no stock field', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Edit product' })).toBeInTheDocument();
    expect(sku()).toHaveValue('SKU-9');
    expect(productName()).toHaveValue('USB Hub');
    expect(price()).toHaveValue('24.50');
    expect(screen.queryByLabelText(/stock quantity/i)).not.toBeInTheDocument();
    expect(sku()).toHaveFocus();
    expect(screen.getByText(/Stock is changed with Adjust stock/)).toBeInTheDocument();
  });

  test('Cancel calls onCancel and sends nothing', () => {
    const { onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('saving', () => {
  test('PATCHes only the fields that changed and reports the saved product', async () => {
    const saved = { ...PRODUCT, name: 'USB-C Hub' };
    fetch.mockImplementation(async () => reply({ product: saved }));
    const { onSaved } = setup();
    fireEvent.change(productName(), { target: { value: '  USB-C Hub ' } });
    fireEvent.click(save());

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/products/9');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body)).toEqual({ name: 'USB-C Hub' });
  });

  test('saving without any change sends nothing and says so', () => {
    const { onSaved } = setup();
    fireEvent.click(save());
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing has been changed yet');
    expect(fetch).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  test('uses the same rules as Add product and sends nothing when they fail', () => {
    setup();
    fireEvent.change(sku(), { target: { value: 'has space' } });
    fireEvent.change(price(), { target: { value: '1.999' } });
    fireEvent.click(save());
    expect(screen.getByText('SKU cannot contain spaces.')).toBeInTheDocument();
    expect(screen.getByText(/Enter a price such as 19\.99/)).toBeInTheDocument();
    expect(sku()).toHaveFocus();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('a second click while saving does not send a second request', async () => {
    let finish;
    fetch.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    setup();
    fireEvent.change(productName(), { target: { value: 'New name' } });
    const form = save().closest('form');
    fireEvent.click(save());
    fireEvent.submit(form);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    finish(reply({ product: PRODUCT }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });
});

describe('failures', () => {
  test('a duplicate SKU (409) is shown on the SKU field and nothing is reported as saved', async () => {
    fetch.mockImplementation(async () => reply({ error: 'dup', fields: ['sku'] }, 409));
    const { onSaved } = setup();
    fireEvent.change(sku(), { target: { value: 'TAKEN' } });
    fireEvent.click(save());

    expect(await screen.findByText(/A product with this SKU already exists/)).toBeInTheDocument();
    expect(sku()).toHaveFocus();
    expect(onSaved).not.toHaveBeenCalled();
    expect(save()).toBeEnabled();
  });

  test('a 404 says the product no longer exists', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Product not found' }, 404));
    const { onSaved } = setup();
    fireEvent.change(productName(), { target: { value: 'x' } });
    fireEvent.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent('This product no longer exists');
    expect(onSaved).not.toHaveBeenCalled();
  });

  test('a 400 marks the fields the server named', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Invalid request', fields: ['price'] }, 400));
    setup();
    fireEvent.change(price(), { target: { value: '5.00' } });
    fireEvent.click(save());
    expect(await screen.findByText('The server did not accept this value. Please check it.')).toBeInTheDocument();
    expect(price()).toHaveFocus();
  });

  test('a network failure warns that the change may not have been saved', async () => {
    fetch.mockImplementation(async () => {
      throw new TypeError('failed');
    });
    const { onSaved } = setup();
    fireEvent.change(productName(), { target: { value: 'x' } });
    fireEvent.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent('may not have been saved');
    expect(onSaved).not.toHaveBeenCalled();
  });

  test('a reply without a product is not treated as saved', async () => {
    fetch.mockImplementation(async () => reply({}));
    const { onSaved } = setup();
    fireEvent.change(productName(), { target: { value: 'x' } });
    fireEvent.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent('may or may not have been saved');
    expect(onSaved).not.toHaveBeenCalled();
  });
});
