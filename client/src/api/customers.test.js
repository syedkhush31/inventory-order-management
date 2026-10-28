// The customer API functions with a fake fetch: no server is involved.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createCustomer, listCustomers, setCustomerActive, updateCustomer } from './customers.js';
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
const customer = { id: 9, name: 'Ann Lee', email: 'ann@example.com', phone: null, address: null, isActive: true };
const base = { q: '', status: 'active', page: 1, pageSize: 25, sort: 'name', order: 'asc' };

describe('listCustomers', () => {
  test('requests the list with cookies and the right query string', async () => {
    fetch.mockImplementation(async () => reply({ items: [], page: 2, pageSize: 25, total: 0, totalPages: 0 }));
    await listCustomers({ ...base, q: 'ann', status: 'all', page: 2, sort: 'updatedAt', order: 'desc' });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/customers?q=ann&status=all&page=2&pageSize=25&sort=updatedAt&order=desc');
    expect(options.method).toBe('GET');
    expect(options.credentials).toBe('include');
  });

  test('leaves out an empty search, encodes special characters and passes the abort signal', async () => {
    fetch.mockImplementation(async () => reply({ items: [] }));
    await listCustomers(base);
    expect(fetch.mock.calls[0][0]).toBe('/api/customers?status=active&page=1&pageSize=25&sort=name&order=asc');
    const controller = new AbortController();
    await listCustomers({ ...base, q: 'a&b=c 50%' }, { signal: controller.signal });
    expect(fetch.mock.calls[1][0]).toContain('q=a%26b%3Dc+50%25');
    expect(fetch.mock.calls[1][1].signal).toBe(controller.signal);
  });
});

describe('createCustomer', () => {
  test('POSTs only the four allowed fields as JSON with cookies and returns the customer', async () => {
    fetch.mockImplementation(async () => reply({ customer }, 201));
    const created = await createCustomer({ name: 'Ann Lee', email: 'ann@example.com', phone: null, address: null, isActive: false });
    expect(created).toEqual(customer);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/customers');
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('include');
    expect(JSON.parse(options.body)).toEqual({ name: 'Ann Lee', email: 'ann@example.com', phone: null, address: null });
  });

  test('a 409 becomes an ApiError carrying the field names; a reply without a customer is not trusted', async () => {
    fetch.mockImplementationOnce(async () => reply({ error: 'dup', fields: ['email'] }, 409));
    await expect(createCustomer({ name: 'A', email: 'a@b.co' })).rejects.toMatchObject({ status: 409, body: { fields: ['email'] } });
    fetch.mockImplementationOnce(async () => reply({}, 201));
    await expect(createCustomer({ name: 'A', email: 'a@b.co' })).rejects.toBeInstanceOf(UnexpectedResponseError);
    fetch.mockImplementationOnce(async () => {
      throw new TypeError('failed');
    });
    await expect(createCustomer({ name: 'A', email: 'a@b.co' })).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('updateCustomer', () => {
  test('PATCHes only the given allowed fields, keeping null so a field can be cleared', async () => {
    fetch.mockImplementation(async () => reply({ customer }));
    await updateCustomer(9, { phone: null, name: 'Ann', isActive: false, id: 3 });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/customers/9');
    expect(options.method).toBe('PATCH');
    expect(options.credentials).toBe('include');
    expect(JSON.parse(options.body)).toEqual({ name: 'Ann', phone: null });
  });

  test('a 404 is an ApiError and a reply without a customer is an UnexpectedResponseError', async () => {
    fetch.mockImplementationOnce(async () => reply({ error: 'Customer not found' }, 404));
    await expect(updateCustomer(9, { name: 'x' })).rejects.toBeInstanceOf(ApiError);
    fetch.mockImplementationOnce(async () => reply({}));
    await expect(updateCustomer(9, { name: 'x' })).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});

describe('setCustomerActive', () => {
  test('POSTs to deactivate or reactivate with an encoded id', async () => {
    fetch.mockImplementation(async () => reply({ customer }));
    await setCustomerActive(9, false);
    await setCustomerActive(9, true);
    await setCustomerActive('a/b', false);
    expect(fetch.mock.calls[0][0]).toBe('/api/customers/9/deactivate');
    expect(fetch.mock.calls[1][0]).toBe('/api/customers/9/reactivate');
    expect(fetch.mock.calls[2][0]).toBe('/api/customers/a%2Fb/deactivate');
    for (const [, options] of fetch.mock.calls) {
      expect(options.method).toBe('POST');
      expect(options.credentials).toBe('include');
    }
  });

  test('a reply without a customer is an UnexpectedResponseError', async () => {
    fetch.mockImplementation(async () => reply({}));
    await expect(setCustomerActive(9, false)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});
