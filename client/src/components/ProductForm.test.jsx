// The Add product form with a fake fetch: no backend or database is involved.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProductForm from './ProductForm.jsx';
import { setUnauthorizedHandler } from '../api/client.js';

const CREATED = {
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
const stock = () => screen.getByLabelText(/^Initial stock quantity/);
const submit = () => screen.getByRole('button', { name: 'Add product' });

function fill({ s = 'SKU-9', n = 'USB Hub', p = '24.50', q = '15' } = {}) {
  fireEvent.change(sku(), { target: { value: s } });
  fireEvent.change(productName(), { target: { value: n } });
  fireEvent.change(price(), { target: { value: p } });
  fireEvent.change(stock(), { target: { value: q } });
}

function setup() {
  const onCreated = vi.fn();
  const onCancel = vi.fn();
  render(<ProductForm onCreated={onCreated} onCancel={onCancel} />);
  return { onCreated, onCancel };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

describe('layout and accessibility', () => {
  test('has labelled fields, hints and required marks, and starts with the SKU field focused', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Add product' })).toBeInTheDocument();
    expect(sku()).toHaveFocus();

    expect(sku()).toHaveAttribute('aria-required', 'true');
    expect(productName()).toHaveAttribute('aria-required', 'true');
    expect(price()).toHaveAttribute('aria-required', 'true');
    expect(stock()).not.toHaveAttribute('aria-required'); // stock is optional

    expect(sku()).toHaveAccessibleDescription(/Letters, digits and - _ \. \/ only, no spaces/);
    expect(price()).toHaveAccessibleDescription(/For example 19\.99/);
    expect(stock()).toHaveAccessibleDescription(/Leave blank for 0/);
    expect(screen.getByText(/are required\. New products are created as active\./)).toBeInTheDocument();
  });

  test('price and stock use text inputs with numeric keyboards, so e-notation and spinners are avoided', () => {
    setup();
    expect(price()).toHaveAttribute('inputmode', 'decimal');
    expect(price().type).toBe('text'); // a plain text input (no browser number spinner or "e" notation)
    expect(stock().type).toBe('text');
    expect(stock()).toHaveAttribute('inputmode', 'numeric');
  });
});

describe('validation before sending', () => {
  test('required fields show errors, focus moves to the first one, and nothing is sent', () => {
    setup();
    fireEvent.click(submit());

    expect(screen.getByText('Enter a SKU.')).toBeInTheDocument();
    expect(screen.getByText('Enter a product name.')).toBeInTheDocument();
    expect(screen.getByText('Enter a price.')).toBeInTheDocument();
    expect(sku()).toHaveFocus();
    expect(sku()).toHaveAttribute('aria-invalid', 'true');
    expect(sku()).toHaveAccessibleDescription(/Enter a SKU\./);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('focus goes to the first invalid field in screen order', () => {
    setup();
    fill({ s: 'OK-1', n: 'Name', p: '1.234' });
    fireEvent.click(submit());
    expect(price()).toHaveFocus();
  });

  test.each([
    ['sku with a space', { s: 'AB 12' }, 'SKU cannot contain spaces.'],
    ['sku with a bad character', { s: 'AB#1' }, /Use only letters, digits/],
    ['price with 3 decimals', { p: '1.234' }, /Enter a price such as 19\.99/],
    ['negative price', { p: '-5' }, /Enter a price such as 19\.99/],
    ['exponent price', { p: '1e3' }, /Enter a price such as 19\.99/],
    ['decimal stock', { q: '1.5' }, 'Enter a whole number, 0 or more.'],
    ['negative stock', { q: '-1' }, 'Enter a whole number, 0 or more.'],
    ['stock over the limit', { q: '4294967296' }, 'Stock cannot be more than 4,294,967,295.'],
  ])('%s is caught without sending', (_label, values, message) => {
    setup();
    fill(values);
    fireEvent.click(submit());
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('an error disappears as soon as the user edits that field', () => {
    setup();
    fireEvent.click(submit());
    expect(screen.getByText('Enter a SKU.')).toBeInTheDocument();
    fireEvent.change(sku(), { target: { value: 'A' } });
    expect(screen.queryByText('Enter a SKU.')).not.toBeInTheDocument();
    expect(screen.getByText('Enter a product name.')).toBeInTheDocument(); // other errors stay
  });
});

describe('successful submission', () => {
  test('POSTs the trimmed values with cookies and reports the saved product', async () => {
    fetch.mockImplementation(async () => reply({ product: CREATED }, 201));
    const { onCreated } = setup();
    fill({ s: '  SKU-9 ', n: '  USB Hub ', p: ' 24.50 ', q: ' 15 ' });
    fireEvent.click(submit());

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(CREATED));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/products');
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('include');
    expect(JSON.parse(options.body)).toEqual({ sku: 'SKU-9', name: 'USB Hub', price: '24.50', stockQuantity: 15 });
  });

  test('a blank stock field is sent as 0', async () => {
    fetch.mockImplementation(async () => reply({ product: { ...CREATED, stockQuantity: 0 } }, 201));
    const { onCreated } = setup();
    fill({ q: '' });
    fireEvent.click(submit());
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(JSON.parse(fetch.mock.calls[0][1].body).stockQuantity).toBe(0);
  });

  test('the price is sent as exact text, never as a number', async () => {
    fetch.mockImplementation(async () => reply({ product: CREATED }, 201));
    const { onCreated } = setup();
    fill({ p: '0.10' });
    fireEvent.click(submit());
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.price).toBe('0.10');
    expect(typeof body.price).toBe('string');
  });
});

describe('loading state and duplicate submissions', () => {
  test('shows Saving…, disables both buttons, and ignores a second submit while the request is pending', async () => {
    let finish;
    fetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(reply({ product: CREATED }, 201));
        })
    );
    const { onCreated, onCancel } = setup();
    fill();
    fireEvent.click(submit());

    const saving = await screen.findByRole('button', { name: 'Saving…' });
    expect(saving).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

    fireEvent.submit(saving.closest('form')); // pressing Enter again
    fireEvent.click(saving);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();

    finish();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });
});

describe('server errors', () => {
  test('409 duplicate SKU shows the error beside the SKU field, focuses it and keeps the other values', async () => {
    fetch.mockImplementation(async () => reply({ error: 'A product with this SKU already exists', fields: ['sku'] }, 409));
    const { onCreated } = setup();
    fill();
    fireEvent.click(submit());

    expect(await screen.findByText('A product with this SKU already exists. Choose a different SKU.')).toBeInTheDocument();
    expect(sku()).toHaveFocus();
    expect(sku()).toHaveAttribute('aria-invalid', 'true');
    expect(productName()).toHaveValue('USB Hub');
    expect(price()).toHaveValue('24.50');
    expect(onCreated).not.toHaveBeenCalled();
    expect(submit()).toBeEnabled(); // the user can fix the SKU and try again
  });

  test('400 with field names maps them to the right inputs', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Invalid request', fields: ['price', 'stockQuantity'] }, 400));
    const { onCreated } = setup();
    fill();
    fireEvent.click(submit());

    expect(await screen.findByRole('alert')).toHaveTextContent('not saved');
    expect(price()).toHaveAttribute('aria-invalid', 'true');
    expect(stock()).toHaveAttribute('aria-invalid', 'true');
    expect(sku()).toHaveAttribute('aria-invalid', 'false');
    expect(price()).toHaveFocus();
    expect(onCreated).not.toHaveBeenCalled();
  });

  test('400 without usable field names still shows a clear form-level error', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Invalid request', fields: [] }, 400));
    setup();
    fill();
    fireEvent.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('not saved');
    expect(submit()).toBeEnabled();
  });

  test('a network failure says the product may not have been saved and keeps what was typed', async () => {
    fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const { onCreated } = setup();
    fill();
    fireEvent.click(submit());

    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server, so the product may not have been saved.');
    expect(sku()).toHaveValue('SKU-9');
    expect(onCreated).not.toHaveBeenCalled();
    expect(submit()).toBeEnabled();
  });

  test('an unexpected 500 shows a generic message with no server details', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Internal server error' }, 500));
    const { onCreated } = setup();
    fill();
    fireEvent.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong and the product was not saved.');
    expect(onCreated).not.toHaveBeenCalled();
  });

  test('a created reply without the product is not treated as a confirmed save', async () => {
    fetch.mockImplementation(async () => new Response('not json', { status: 201 }));
    const { onCreated } = setup();
    fill();
    fireEvent.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('may or may not have been saved');
    expect(onCreated).not.toHaveBeenCalled();
  });

  test('a 401 tells the app the session has ended and does not report success', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetch.mockImplementation(async () => reply({ error: 'Authentication required' }, 401));
    const { onCreated } = setup();
    fill();
    fireEvent.click(submit());
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe('cancel', () => {
  test('Cancel calls onCancel and never contacts the server', () => {
    const { onCancel, onCreated } = setup();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
