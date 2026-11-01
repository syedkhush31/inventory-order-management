// The account API functions with a fake fetch: no server is involved, and no real password is ever sent anywhere.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { changePassword, getAccount, updateProfile } from './account.js';
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
const account = { id: 7, email: 'admin@example.com', displayName: 'Sam', createdAt: '2026-10-01T09:00:00.000Z' };

describe('getAccount', () => {
  test('requests the account with cookies and returns it', async () => {
    fetch.mockImplementation(async () => reply({ account }));
    await expect(getAccount()).resolves.toEqual(account);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/account');
    expect(options.method).toBe('GET');
    expect(options.credentials).toBe('include');
  });

  test('a reply without an account is not trusted', async () => {
    fetch.mockImplementation(async () => reply({}));
    await expect(getAccount()).rejects.toBeInstanceOf(UnexpectedResponseError);
    fetch.mockImplementation(async () => reply({ account: { id: 7 } }));
    await expect(getAccount()).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  test('passes the abort signal along', async () => {
    fetch.mockImplementation(async () => reply({ account }));
    const controller = new AbortController();
    await getAccount({ signal: controller.signal });
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
  });
});

describe('updateProfile', () => {
  test('sends only the fields given, as a PATCH', async () => {
    fetch.mockImplementation(async () => reply({ account }));
    await updateProfile({ displayName: 'Sam' });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/account/profile');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body)).toEqual({ displayName: 'Sam' });
  });

  test('can send a cleared display name (null) and an email with the current password', async () => {
    fetch.mockImplementation(async () => reply({ account }));
    await updateProfile({ displayName: null });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ displayName: null });
    await updateProfile({ email: 'new@example.com', currentPassword: 'the-current-password' });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ email: 'new@example.com', currentPassword: 'the-current-password' });
  });

  test('returns the saved account', async () => {
    fetch.mockImplementation(async () => reply({ account: { ...account, displayName: 'New' } }));
    await expect(updateProfile({ displayName: 'New' })).resolves.toMatchObject({ displayName: 'New' });
  });

  test('a reply without an account cannot be confirmed as a save', async () => {
    fetch.mockImplementation(async () => reply({ ok: true }));
    await expect(updateProfile({ displayName: 'x' })).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  test.each([
    [400, { error: 'Invalid request', fields: ['email'] }],
    [403, { error: 'Current password is incorrect', fields: ['currentPassword'] }],
    [409, { error: 'Another account already uses this email', fields: ['email'] }],
    [429, { error: 'Too many incorrect password attempts. Please try again later.' }],
  ])('a %i reply is thrown as an ApiError with its body', async (status, body) => {
    fetch.mockImplementation(async () => reply(body, status));
    await expect(updateProfile({ email: 'x@example.com', currentPassword: 'p' })).rejects.toMatchObject({ name: 'ApiError', status, body });
  });

  test('a lost connection is a NetworkError', async () => {
    fetch.mockRejectedValue(new TypeError('failed'));
    await expect(updateProfile({ displayName: 'x' })).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('changePassword', () => {
  test('posts both passwords once, in the request body only', async () => {
    fetch.mockImplementation(async () => reply({ message: 'Password changed. Other sessions have been signed out.' }));
    const message = await changePassword({ currentPassword: 'old-password-value', newPassword: 'new-password-value-1' });
    expect(message).toMatch(/Password changed/);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('/api/account/password');
    expect(url).not.toMatch(/password-value/); // never in the address
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ currentPassword: 'old-password-value', newPassword: 'new-password-value-1' });
    expect(options.credentials).toBe('include');
  });

  test('a reply without a message cannot be confirmed', async () => {
    fetch.mockImplementation(async () => reply({}));
    await expect(changePassword({ currentPassword: 'a', newPassword: 'b' })).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  test.each([
    [400, { error: 'Invalid request', fields: ['newPassword'] }],
    [403, { error: 'Current password is incorrect', fields: ['currentPassword'] }],
    [429, { error: 'Too many incorrect password attempts. Please try again later.' }],
  ])('a %i reply is thrown as an ApiError', async (status, body) => {
    fetch.mockImplementation(async () => reply(body, status));
    await expect(changePassword({ currentPassword: 'a', newPassword: 'b' })).rejects.toMatchObject({ status, body });
  });

  test('the error carries no password', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Current password is incorrect', fields: ['currentPassword'] }, 403));
    try {
      await changePassword({ currentPassword: 'secret-old-password', newPassword: 'secret-new-password' });
    } catch (err) {
      expect(JSON.stringify(err.body) + err.message + String(err.stack)).not.toMatch(/secret-old-password|secret-new-password/);
    }
  });

  test('a 401 tells the app the session ended (the shared handler is notified)', async () => {
    fetch.mockImplementation(async () => reply({ error: 'Authentication required' }, 401));
    await expect(changePassword({ currentPassword: 'a', newPassword: 'b' })).rejects.toBeInstanceOf(ApiError);
  });
});
