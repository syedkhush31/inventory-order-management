import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createProduct, listProducts, UnexpectedResponseError } from './products.js';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const base = { q: '', status: 'active', page: 1, pageSize: 25, sort: 'name', order: 'asc' };

test('requests the product list with cookies and the right query string', async () => {
  fetch.mockImplementation(async () => reply({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 }));
  const data = await listProducts({ ...base, q: 'mouse', status: 'all', page: 2, sort: 'stockQuantity', order: 'desc' });

  expect(data.total).toBe(0);
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe('/api/products?q=mouse&status=all&page=2&pageSize=25&sort=stockQuantity&order=desc');
  expect(options.credentials).toBe('include');
  expect(options.method).toBe('GET');
});

test('leaves out an empty search and encodes special characters', async () => {
  fetch.mockImplementation(async () => reply({ items: [] }));
  await listProducts(base);
  expect(fetch.mock.calls[0][0]).toBe('/api/products?status=active&page=1&pageSize=25&sort=name&order=asc');

  await listProducts({ ...base, q: 'a&b=c 50%' });
  expect(fetch.mock.calls[1][0]).toContain('q=a%26b%3Dc+50%25');
});

test('passes the abort signal to fetch', async () => {
  fetch.mockImplementation(async () => reply({ items: [] }));
  const controller = new AbortController();
  await listProducts(base, { signal: controller.signal });
  expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
});

describe('createProduct', () => {
  const body = { sku: 'SKU-9', name: 'USB Hub', price: '24.50', stockQuantity: 15 };
  const product = { id: 9, ...body, isActive: true };

  test('POSTs only the four allowed fields as JSON with cookies and returns the product', async () => {
    fetch.mockImplementation(async () => new Response(JSON.stringify({ product }), { status: 201 }));
    const created = await createProduct({ ...body, isActive: false, id: 5 }); // extra properties are not forwarded

    expect(created).toEqual(product);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/products');
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('include');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(options.body)).toEqual(body);
  });

  test('a 409 becomes an ApiError that carries the field names', async () => {
    fetch.mockImplementation(
      async () => new Response(JSON.stringify({ error: 'A product with this SKU already exists', fields: ['sku'] }), { status: 409 })
    );
    await expect(createProduct(body)).rejects.toMatchObject({ name: 'ApiError', status: 409, body: { fields: ['sku'] } });
  });

  test('a reply without a product is reported as unexpected, never as a success', async () => {
    fetch.mockImplementation(async () => new Response('', { status: 201 }));
    await expect(createProduct(body)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  test('a network failure is a NetworkError', async () => {
    fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createProduct(body)).rejects.toMatchObject({ name: 'NetworkError' });
  });
});
