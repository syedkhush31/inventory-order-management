// The Adjust stock form with a fake fetch: no backend or database is involved.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import StockAdjustForm from './StockAdjustForm.jsx';
import { setUnauthorizedHandler } from '../api/client.js';

const PRODUCT = {
  id: 9,
  sku: 'SKU-9',
  name: 'USB Hub',
  price: '24.50',
  stockQuantity: 10,
  isActive: true,
  createdAt: '2026-10-28T09:00:00.000Z',
  updatedAt: '2026-10-28T09:00:00.000Z',
};

const RESULT = {
  product: { ...PRODUCT, stockQuantity: 7 },
  adjustment: { id: 1, productId: 9, quantityDelta: -3, reason: 'Damaged', adminId: 7, createdAt: '2026-10-28T10:00:00.000Z' },
};

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const delta = () => screen.getByLabelText(/^Change in stock/);
const reason = () => screen.getByLabelText(/^Reason/);
const save = () => screen.getByRole('button', { name: 'Save correction' });
const preview = () => screen.getByRole('status');

function fill(d, r = 'Damaged') {
  fireEvent.change(delta(), { target: { value: d } });
  fireEvent.change(reason(), { target: { value: r } });
}

function setup(product = PRODUCT) {
  const onAdjusted = vi.fn();
  const onCancel = vi.fn();
  render(<StockAdjustForm product={product} onAdjusted={onAdjusted} onCancel={onCancel} />);
  return { onAdjusted, onCancel };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

describe('layout and live preview', () => {
  test('shows the product, the current stock, and focuses the change field', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Adjust stock: SKU-9' })).toBeInTheDocument();
    expect(screen.getByText(/on hand now/)).toHaveTextContent('USB Hub — 10 on hand now');
    expect(delta()).toHaveFocus();
    expect(preview()).toHaveTextContent('Type a change to see the new stock.');
  });

  test('previews the resulting stock as the user types', () => {
    setup();
    fireEvent.change(delta(), { target: { value: '-3' } });
    expect(preview()).toHaveTextContent('Stock after this change: 7');
    fireEvent.change(delta(), { target: { value: '+5' } });
    expect(preview()).toHaveTextContent('Stock after this change: 15');
  });

  test('warns when the change would make stock negative', () => {
    setup();
    fireEvent.change(delta(), { target: { value: '-11' } });
    expect(preview()).toHaveTextContent('This would leave -1. Stock cannot go below 0.');
    expect(preview()).toHaveClass('stock-preview--bad');
  });

  test('mentions that an inactive product can still be corrected', () => {
    setup({ ...PRODUCT, isActive: false });
    expect(screen.getByText(/This product is inactive; its stock can still be corrected/)).toBeInTheDocument();
  });
});

describe('validation before sending', () => {
  test('a negative result is blocked and nothing is sent', () => {
    const { onAdjusted } = setup();
    fill('-11');
    fireEvent.click(save());
    expect(screen.getByText('Stock cannot go below 0. Only 10 on hand.')).toBeInTheDocument();
    expect(delta()).toHaveAttribute('aria-invalid', 'true');
    expect(delta()).toHaveFocus();
    expect(fetch).not.toHaveBeenCalled();
    expect(onAdjusted).not.toHaveBeenCalled();
  });

  test.each([
    ['', 'Damaged', 'Enter the change in stock, such as 5 or -3.'],
    ['0', 'Damaged', 'The change cannot be 0.'],
    ['1.5', 'Damaged', 'Enter a whole number such as 5 or -3.'],
    ['2', '   ', 'Enter a reason for the correction.'],
  ])('change %p with reason %p shows an error and sends nothing', (d, r, message) => {
    setup();
    fill(d, r);
    fireEvent.click(save());
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('an error disappears when the user edits that field', () => {
    setup();
    fireEvent.click(save());
    expect(screen.getByText('Enter a reason for the correction.')).toBeInTheDocument();
    fireEvent.change(reason(), { target: { value: 'x' } });
    expect(screen.queryByText('Enter a reason for the correction.')).not.toBeInTheDocument();
  });
});

describe('saving', () => {
  test('POSTs only delta and the trimmed reason and reports the result', async () => {
    fetch.mockImplementation(async () => reply(RESULT, 201));
    const { onAdjusted } = setup();
    fill(' -3 ', '  Damaged  ');
    fireEvent.click(save());

    await waitFor(() => expect(onAdjusted).toHaveBeenCalledWith(RESULT));
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/products/9/stock-adjustments');
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('include');
    expect(JSON.parse(options.body)).toEqual({ delta: -3, reason: 'Damaged' });
  });

  test('removing exactly all the stock is sent', async () => {
    fetch.mockImplementation(async () => reply(RESULT, 201));
    setup();
    fill('-10');
    fireEvent.click(save());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetch.mock.calls[0][1].body).delta).toBe(-10);
  });

  test('a second submit while saving does not send a second request', async () => {
    let finish;
    fetch.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    setup();
    fill('-3');
    const form = save().closest('form');
    fireEvent.click(save());
    fireEvent.submit(form);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    finish(reply(RESULT, 201));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  });
});

describe('server failures', () => {
  test('a 409 shows the stock the server reports and does not report success', async () => {
    fetch.mockImplementation(async () =>
      reply({ error: 'Not enough stock for this adjustment', fields: ['delta'], currentStock: 2 }, 409)
    );
    const { onAdjusted } = setup();
    fill('-3');
    fireEvent.click(save());

    expect(await screen.findByText(/This correction could not be applied\. There are 2 on hand right now/)).toBeInTheDocument();
    expect(onAdjusted).not.toHaveBeenCalled();
    expect(save()).toBeEnabled();
  });

  test('a 404 says the product no longer exists', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Product not found' }, 404));
    setup();
    fill('-3');
    fireEvent.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent('This product no longer exists');
  });

  test('a 400 marks the fields the server named', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Invalid request', fields: ['reason'] }, 400));
    setup();
    fill('-3');
    fireEvent.click(save());
    expect(await screen.findByText('The server did not accept this value. Please check it.')).toBeInTheDocument();
    expect(reason()).toHaveFocus();
  });

  test('a network failure warns that the correction may not have been saved', async () => {
    fetch.mockImplementation(async () => {
      throw new TypeError('failed');
    });
    const { onAdjusted } = setup();
    fill('-3');
    fireEvent.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent('may not have been saved');
    expect(onAdjusted).not.toHaveBeenCalled();
  });

  test('a reply without the adjustment is not treated as saved', async () => {
    fetch.mockImplementation(async () => reply({ product: RESULT.product }, 201));
    const { onAdjusted } = setup();
    fill('-3');
    fireEvent.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent('may or may not have been saved');
    expect(onAdjusted).not.toHaveBeenCalled();
  });
});
