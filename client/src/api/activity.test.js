// The activity API function with a fake fetch: no server or database is involved.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { listActivity } from './activity.js';
import { ApiError, NetworkError } from './client.js';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const base = { q: '', type: 'all', page: 1, pageSize: 25 };

describe('listActivity', () => {
  test('requests the list with cookies and only the parameters it was given', async () => {
    fetch.mockImplementation(async () => reply({ items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 }));
    await listActivity(base);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/activity?type=all&page=1&pageSize=25');
    expect(options.method).toBe('GET');
    expect(options.credentials).toBe('include');
  });

  test('sends the search, type and the date range as given, encoded', async () => {
    fetch.mockImplementation(async () => reply({ items: [] }));
    await listActivity({ q: '#12 & co', type: 'order', from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z', page: 3, pageSize: 25 });
    expect(fetch.mock.calls[0][0]).toBe(
      '/api/activity?q=%2312+%26+co&type=order&from=2026-11-01T00%3A00%3A00.000Z&to=2026-11-02T00%3A00%3A00.000Z&page=3&pageSize=25'
    );
  });

  test('leaves out an empty search and missing dates', async () => {
    fetch.mockImplementation(async () => reply({ items: [] }));
    await listActivity({ ...base, q: '', from: undefined, to: undefined });
    expect(fetch.mock.calls[0][0]).not.toMatch(/[?&](q|from|to)=/);
  });

  test('passes the abort signal along', async () => {
    fetch.mockImplementation(async () => reply({ items: [] }));
    const controller = new AbortController();
    await listActivity(base, { signal: controller.signal });
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
  });

  test('is read-only: it only ever sends GET', async () => {
    fetch.mockImplementation(async () => reply({ items: [] }));
    await listActivity(base);
    expect(fetch.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  });

  test('400 and 500 replies become an ApiError, a lost connection a NetworkError', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Invalid request', fields: ['to'] }, 400));
    await expect(listActivity(base)).rejects.toMatchObject({ name: 'ApiError', status: 400, body: { fields: ['to'] } });
    fetch.mockImplementation(async () => reply({ error: 'Internal server error' }, 500));
    await expect(listActivity(base)).rejects.toBeInstanceOf(ApiError);
    fetch.mockRejectedValue(new TypeError('failed'));
    await expect(listActivity(base)).rejects.toBeInstanceOf(NetworkError);
  });
});
