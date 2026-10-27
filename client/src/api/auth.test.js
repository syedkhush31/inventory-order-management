// Tests the API helpers with a fake fetch: no real server or network is used.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { login, getCurrentAdmin, logout } from './auth.js';
import { apiRequest, ApiError, NetworkError, setUnauthorizedHandler } from './client.js';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

describe('login', () => {
  test('POSTs the credentials as JSON with cookies included and returns the admin', async () => {
    fetch.mockResolvedValue(jsonResponse(200, { admin: { id: 1, email: 'a@example.com' } }));
    const admin = await login('a@example.com', 'secret-pass');

    expect(admin).toEqual({ id: 1, email: 'a@example.com' });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/auth/login');
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('include');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(options.body)).toEqual({ email: 'a@example.com', password: 'secret-pass' });
  });

  test('a 401 becomes an ApiError with status 401', async () => {
    fetch.mockResolvedValue(jsonResponse(401, { error: 'Invalid email or password' }));
    await expect(login('a@example.com', 'x')).rejects.toMatchObject({ name: 'ApiError', status: 401 });
  });
});

describe('getCurrentAdmin', () => {
  test('returns the admin on 200 and sends credentials', async () => {
    fetch.mockResolvedValue(jsonResponse(200, { admin: { id: 2, email: 'b@example.com' } }));
    expect(await getCurrentAdmin()).toEqual({ id: 2, email: 'b@example.com' });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/auth/me');
    expect(options.credentials).toBe('include');
  });

  test('returns null on 401 (nobody signed in)', async () => {
    fetch.mockResolvedValue(jsonResponse(401, { error: 'Authentication required' }));
    expect(await getCurrentAdmin()).toBeNull();
  });

  test('throws on server errors and network failures instead of pretending to be signed out', async () => {
    fetch.mockResolvedValue(jsonResponse(500, { error: 'Internal server error' }));
    await expect(getCurrentAdmin()).rejects.toBeInstanceOf(ApiError);

    fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(getCurrentAdmin()).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('logout', () => {
  test('POSTs to the logout endpoint with cookies included', async () => {
    fetch.mockResolvedValue(jsonResponse(200, { message: 'Logged out' }));
    await logout();
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/auth/logout');
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('include');
  });
});

describe('apiRequest', () => {
  test('tells the app when a normal request gets a 401, but not when notifyOn401 is off', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    fetch.mockResolvedValue(jsonResponse(401, { error: 'Authentication required' }));

    await expect(apiRequest('/api/products')).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);

    await expect(apiRequest('/api/auth/me', { notifyOn401: false })).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('handles a non-JSON error body', async () => {
    fetch.mockResolvedValue(new Response('Bad gateway', { status: 502 }));
    await expect(apiRequest('/api/anything')).rejects.toMatchObject({ status: 502, body: null });
  });
});
