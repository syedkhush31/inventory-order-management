// The settings API functions with a fake fetch: no server is involved.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getSettings, updateSettings } from './settings.js';
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
const app = { name: 'ShelfSync', serverVersion: '0.1.0', clientVersion: '0.1.0', environment: 'development' };

describe('getSettings', () => {
  test('requests the settings with cookies and returns the settings and the application information', async () => {
    fetch.mockImplementation(async () => reply({ settings: { lowStockThreshold: 12 }, app }));
    await expect(getSettings()).resolves.toEqual({ settings: { lowStockThreshold: 12 }, app });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/settings');
    expect(options.method).toBe('GET');
    expect(options.credentials).toBe('include');
  });

  test('passes the abort signal along', async () => {
    fetch.mockImplementation(async () => reply({ settings: { lowStockThreshold: 5 }, app }));
    const controller = new AbortController();
    await getSettings({ signal: controller.signal });
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
  });

  test('the application information is returned exactly as the server sent it, with a null version kept as null', async () => {
    const sent = { ...app, clientVersion: null };
    fetch.mockImplementation(async () => reply({ settings: { lowStockThreshold: 5 }, app: sent }));
    expect((await getSettings()).app).toEqual(sent);
  });

  test.each([
    ['no body', {}],
    ['no settings', { app }],
    ['no app information', { settings: { lowStockThreshold: 5 } }],
    ['a threshold that is text', { settings: { lowStockThreshold: '5' }, app }],
    ['a threshold that is a decimal', { settings: { lowStockThreshold: 5.5 }, app }],
    ['a null threshold', { settings: { lowStockThreshold: null }, app }],
    ['app information that is not an object', { settings: { lowStockThreshold: 5 }, app: 'x' }],
  ])('a reply with %s is not trusted (never turned into a made-up number)', async (_label, body) => {
    fetch.mockImplementation(async () => reply(body));
    await expect(getSettings()).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  test('401 and network failures are thrown', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Authentication required' }, 401));
    await expect(getSettings()).rejects.toMatchObject({ status: 401 });
    fetch.mockRejectedValue(new TypeError('failed'));
    await expect(getSettings()).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('updateSettings', () => {
  test('sends the threshold as a number in a PATCH and returns the saved settings', async () => {
    fetch.mockImplementation(async () => reply({ settings: { lowStockThreshold: 20 } }));
    await expect(updateSettings({ lowStockThreshold: 20 })).resolves.toEqual({ lowStockThreshold: 20 });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/settings');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body)).toEqual({ lowStockThreshold: 20 });
    expect(typeof JSON.parse(options.body).lowStockThreshold).toBe('number');
  });

  test('sends nothing but the threshold', async () => {
    fetch.mockImplementation(async () => reply({ settings: { lowStockThreshold: 0 } }));
    await updateSettings({ lowStockThreshold: 0, extra: 'ignored', environment: 'production' });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ lowStockThreshold: 0 });
  });

  test('a reply without a saved threshold cannot be confirmed', async () => {
    fetch.mockImplementation(async () => reply({}));
    await expect(updateSettings({ lowStockThreshold: 5 })).rejects.toBeInstanceOf(UnexpectedResponseError);
    fetch.mockImplementation(async () => reply({ settings: { lowStockThreshold: 'x' } }));
    await expect(updateSettings({ lowStockThreshold: 5 })).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  test('a 400 is thrown with the field the server named, a lost connection as a NetworkError', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Invalid request', fields: ['lowStockThreshold'] }, 400));
    await expect(updateSettings({ lowStockThreshold: 5000 })).rejects.toMatchObject({ name: 'ApiError', status: 400, body: { fields: ['lowStockThreshold'] } });
    fetch.mockRejectedValue(new TypeError('failed'));
    await expect(updateSettings({ lowStockThreshold: 5 })).rejects.toBeInstanceOf(NetworkError);
    fetch.mockImplementation(async () => reply({ error: 'Internal server error' }, 500));
    await expect(updateSettings({ lowStockThreshold: 5 })).rejects.toBeInstanceOf(ApiError);
  });
});
