// The order API functions with a fake fetch: no server or database is involved.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createOrder, getOrder, listOrders, orderAction } from './orders.js';
import { UnexpectedResponseError } from './products.js';
import { ApiError, NetworkError } from './client.js';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const order = { id: 7, status: 'PENDING', totalAmount: '20.00', items: [], statusHistory: [] };
const base = { q: '', status: 'all', page: 1, pageSize: 25, sort: 'createdAt', order: 'desc' };

describe('listOrders', () => {
  test('requests the list with cookies and the right query string', async () => {
    fetch.mockImplementation(async () => reply({ items: [], page: 2, pageSize: 25, total: 0, totalPages: 0 }));
    await listOrders({ ...base, q: '#12', status: 'PENDING', page: 2, sort: 'totalAmount', order: 'asc' });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/orders?q=%2312&status=PENDING&page=2&pageSize=25&sort=totalAmount&order=asc');
    expect(options.method).toBe('GET');
    expect(options.credentials).toBe('include');
  });

  test('leaves out an empty search', async () => {
    fetch.mockImplementation(async () => reply({ items: [] }));
    await listOrders(base);
    expect(fetch.mock.calls[0][0]).toBe('/api/orders?status=all&page=1&pageSize=25&sort=createdAt&order=desc');
  });
});

describe('getOrder', () => {
  test('returns the order', async () => {
    fetch.mockImplementation(async () => reply({ order }));
    await expect(getOrder(7)).resolves.toEqual(order);
    expect(fetch.mock.calls[0][0]).toBe('/api/orders/7');
  });

  test('a reply without an order is not trusted', async () => {
    fetch.mockImplementation(async () => reply({}));
    await expect(getOrder(7)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  test('404 becomes an ApiError', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Order not found' }, 404));
    await expect(getOrder(7)).rejects.toMatchObject({ name: 'ApiError', status: 404 });
  });
});

describe('createOrder', () => {
  const input = { customerId: 3, items: [{ productId: 5, quantity: 2, price: '1.00', name: 'ignored' }] };

  test('sends only ids and quantities, never prices, totals or a status', async () => {
    fetch.mockImplementation(async () => reply({ order }, 201));
    await createOrder(input);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/orders');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ customerId: 3, items: [{ productId: 5, quantity: 2 }] });
  });

  test('returns the saved order', async () => {
    fetch.mockImplementation(async () => reply({ order }, 201));
    await expect(createOrder(input)).resolves.toEqual({ order, partial: false });
  });

  test('order:null with detailsAvailable:false is a saved order, not an error', async () => {
    fetch.mockImplementation(async () =>
      reply({ order: null, orderId: 41, status: 'PENDING', totalAmount: '20.00', detailsAvailable: false, message: 'm' }, 201)
    );
    await expect(createOrder(input)).resolves.toEqual({
      order: null,
      partial: true,
      orderId: 41,
      status: 'PENDING',
      totalAmount: '20.00',
    });
  });

  test('a 201 with neither an order nor an order id cannot be confirmed', async () => {
    fetch.mockImplementation(async () => reply({}, 201));
    await expect(createOrder(input)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  test('400, 409 and 503 replies are thrown with their bodies', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Invalid request', fields: ['items'] }, 400));
    await expect(createOrder(input)).rejects.toMatchObject({ status: 400, body: { fields: ['items'] } });
    fetch.mockImplementation(async () => reply({ error: 'Customer is inactive', fields: ['customerId'] }, 409));
    await expect(createOrder(input)).rejects.toMatchObject({ status: 409 });
    fetch.mockImplementation(async () => reply({ error: 'busy' }, 503));
    await expect(createOrder(input)).rejects.toBeInstanceOf(ApiError);
  });

  test('a network failure is a NetworkError', async () => {
    fetch.mockRejectedValue(new TypeError('failed'));
    await expect(createOrder(input)).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('orderAction', () => {
  test.each(['confirm', 'cancel', 'ship', 'deliver'])('%s posts to the right endpoint', async (action) => {
    fetch.mockImplementation(async () => reply({ order }));
    await expect(orderAction(7, action)).resolves.toEqual({ order, partial: false });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe(`/api/orders/7/${action}`);
    expect(options.method).toBe('POST');
  });

  test('refuses an unknown action without calling the server', async () => {
    await expect(orderAction(7, 'delete')).rejects.toThrow('Unknown order action');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('order:null with detailsAvailable:false means the change was saved', async () => {
    fetch.mockImplementation(async () => reply({ order: null, orderId: 7, status: 'CONFIRMED', detailsAvailable: false }));
    await expect(orderAction(7, 'confirm')).resolves.toEqual({ order: null, partial: true, orderId: 7, status: 'CONFIRMED' });
  });

  test('409 shortages and 503 busy are thrown', async () => {
    fetch.mockImplementation(async () => reply({ error: 'x', shortages: [{ productId: 1, requested: 5, available: 2 }] }, 409));
    await expect(orderAction(7, 'confirm')).rejects.toMatchObject({ status: 409, body: { shortages: [{ productId: 1 }] } });
    fetch.mockImplementation(async () => reply({ error: 'busy' }, 503));
    await expect(orderAction(7, 'confirm')).rejects.toMatchObject({ status: 503 });
  });
});
