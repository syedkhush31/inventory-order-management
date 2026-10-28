// updateProduct, setProductActive and adjustStock with a fake fetch: no server is involved.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { adjustStock, setProductActive, updateProduct, UnexpectedResponseError } from './products.js';
import { ApiError, NetworkError } from './client.js';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const product = { id: 9, sku: 'SKU-9', name: 'USB Hub', price: '24.50', stockQuantity: 15, isActive: true };

describe('updateProduct', () => {
  test('PATCHes only the given allowed fields, as JSON with cookies, and returns the product', async () => {
    fetch.mockImplementation(async () => reply({ product }));
    const saved = await updateProduct(9, { name: 'USB Hub', price: '24.50', stockQuantity: 99, isActive: false });

    expect(saved).toEqual(product);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/products/9');
    expect(options.method).toBe('PATCH');
    expect(options.credentials).toBe('include');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(options.body)).toEqual({ name: 'USB Hub', price: '24.50' }); // extras are not forwarded
  });

  test('a 409 carries the field names and a 404 is an ApiError', async () => {
    fetch.mockImplementationOnce(async () => reply({ error: 'dup', fields: ['sku'] }, 409));
    await expect(updateProduct(9, { sku: 'X' })).rejects.toMatchObject({ status: 409, body: { fields: ['sku'] } });
    fetch.mockImplementationOnce(async () => reply({ error: 'Product not found' }, 404));
    await expect(updateProduct(9, { sku: 'X' })).rejects.toBeInstanceOf(ApiError);
  });

  test('a reply without a product is an UnexpectedResponseError, and a dead network is a NetworkError', async () => {
    fetch.mockImplementationOnce(async () => reply({}));
    await expect(updateProduct(9, { sku: 'X' })).rejects.toBeInstanceOf(UnexpectedResponseError);
    fetch.mockImplementationOnce(async () => {
      throw new TypeError('failed');
    });
    await expect(updateProduct(9, { sku: 'X' })).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('setProductActive', () => {
  test('POSTs to deactivate or reactivate and returns the product', async () => {
    fetch.mockImplementation(async () => reply({ product }));
    await setProductActive(9, false);
    await setProductActive(9, true);

    expect(fetch.mock.calls[0][0]).toBe('/api/products/9/deactivate');
    expect(fetch.mock.calls[1][0]).toBe('/api/products/9/reactivate');
    for (const [, options] of fetch.mock.calls) {
      expect(options.method).toBe('POST');
      expect(options.credentials).toBe('include');
    }
  });

  test('a reply without a product is an UnexpectedResponseError', async () => {
    fetch.mockImplementation(async () => reply({}));
    await expect(setProductActive(9, false)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});

describe('adjustStock', () => {
  const result = { product, adjustment: { id: 1, quantityDelta: -3, reason: 'Damaged' } };

  test('POSTs only delta and reason and returns the product and the adjustment', async () => {
    fetch.mockImplementation(async () => reply(result, 201));
    const data = await adjustStock(9, { delta: -3, reason: 'Damaged', adminId: 1 });

    expect(data).toEqual(result);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/products/9/stock-adjustments');
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('include');
    expect(JSON.parse(options.body)).toEqual({ delta: -3, reason: 'Damaged' });
  });

  test('a 409 keeps the current stock the server reported', async () => {
    fetch.mockImplementation(async () => reply({ error: 'x', fields: ['delta'], currentStock: 2 }, 409));
    await expect(adjustStock(9, { delta: -3, reason: 'r' })).rejects.toMatchObject({
      status: 409,
      body: { currentStock: 2 },
    });
  });

  test('a reply missing the product or the adjustment is an UnexpectedResponseError', async () => {
    fetch.mockImplementation(async () => reply({ product }, 201));
    await expect(adjustStock(9, { delta: 1, reason: 'r' })).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});
