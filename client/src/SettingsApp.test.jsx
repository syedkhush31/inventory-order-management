// The whole app (real session handling, sidebar, routing, Settings page and Dashboard) against a stateful fake server.
// Nothing here talks to a real server or database, and no real password exists: the passwords are made-up strings.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App.jsx';

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const OLD_PASSWORD = 'old-test-password-A1';
const NEW_PASSWORD = 'new-test-password-B2';

let server; // what the fake server holds
let override; // 'METHOD /path' -> () => Response, to make one call behave differently

function freshServer() {
  return {
    signedIn: true,
    email: 'admin@example.com',
    displayName: null,
    threshold: 5,
    stocks: [0, 3, 5, 6, 12, 13],
  };
}

beforeEach(() => {
  server = freshServer();
  override = {};
  window.history.replaceState(null, '', '/settings');
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options = {}) => {
      const method = options.method || 'GET';
      const key = `${method} ${String(url).split('?')[0]}`;
      if (override[key]) return override[key](options.body ? JSON.parse(options.body) : undefined);

      const parsed = new URL(String(url), 'http://x');
      const params = parsed.searchParams;
      switch (key) {
        case 'GET /api/auth/me':
          return server.signedIn ? reply({ admin: { id: 7, email: server.email } }) : reply({ error: 'Authentication required' }, 401);
        case 'GET /api/account':
          return reply({ account: { id: 7, email: server.email, displayName: server.displayName, createdAt: '2026-10-01T09:00:00.000Z' } });
        case 'PATCH /api/account/profile': {
          const body = JSON.parse(options.body);
          if (body.displayName !== undefined) server.displayName = body.displayName;
          if (body.email !== undefined) server.email = body.email;
          return reply({ account: { id: 7, email: server.email, displayName: server.displayName, createdAt: '2026-10-01T09:00:00.000Z' } });
        }
        case 'POST /api/account/password':
          return reply({ message: 'Password changed. Other sessions have been signed out.' });
        case 'GET /api/settings':
          return reply({
            settings: { lowStockThreshold: server.threshold },
            app: { name: 'ShelfSync', serverVersion: '0.1.0', clientVersion: '0.1.0', environment: 'development' },
          });
        case 'PATCH /api/settings':
          server.threshold = JSON.parse(options.body).lowStockThreshold;
          return reply({ settings: { lowStockThreshold: server.threshold } });
        case 'GET /api/products': {
          if (params.get('status') === 'active') {
            const items = server.stocks
              .map((stock, i) => ({ id: i + 1, sku: `SKU-${i + 1}`, name: `Product ${i + 1}`, price: '1.00', stockQuantity: stock, isActive: true }))
              .sort((a, b) => a.stockQuantity - b.stockQuantity);
            return reply({ items, page: 1, pageSize: 100, total: items.length, totalPages: 1 });
          }
          return reply({ items: [], page: 1, pageSize: 1, total: 6, totalPages: 6 });
        }
        case 'GET /api/customers':
          return reply({ items: [], page: 1, pageSize: 1, total: 2, totalPages: 2 });
        case 'GET /api/orders':
          return reply({ items: [], page: 1, pageSize: Number(params.get('pageSize')), total: 0, totalPages: 0 });
        default:
          throw new Error(`Unexpected request: ${key}`);
      }
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const calls = (key) => fetch.mock.calls.filter(([url, options = {}]) => `${options.method || 'GET'} ${String(url).split('?')[0]}` === key);
const type = (element, value) => fireEvent.change(element, { target: { value } });
const topBarEmail = () => document.querySelector('.topbar__user strong')?.textContent;

describe('opening Settings', () => {
  test('a direct link or refresh at /settings shows the page, marks it current, and keeps the address', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(await screen.findByRole('form', { name: 'Edit profile' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings');
    expect(screen.getByRole('button', { name: /^Settings/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('navigation', { name: 'Main' })).not.toHaveTextContent('Soon');
  });

  test('clicking Settings in the sidebar opens it and updates the address; Back returns', async () => {
    window.history.replaceState(null, '', '/');
    render(<App />);
    await screen.findByRole('heading', { name: 'Dashboard' });
    fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings');
    window.history.back();
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  test('without a session /settings shows the login page and requests no account or settings data', async () => {
    server.signedIn = false;
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Administrator sign in' })).toBeInTheDocument();
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['/api/auth/me']);
    expect(window.location.pathname).toBe('/settings');
  });
});

describe('the session after Settings changes', () => {
  test('changing the email updates the address shown in the top bar from the server, without leaving the page', async () => {
    render(<App />);
    await screen.findByRole('form', { name: 'Edit profile' });
    expect(topBarEmail()).toBe('admin@example.com');

    const form = screen.getByRole('form', { name: 'Edit profile' });
    type(within(form).getByLabelText('Email address'), 'new@example.com');
    type(within(form).getByLabelText(/Current password/), OLD_PASSWORD);
    fireEvent.click(within(form).getByRole('button', { name: 'Save profile' }));

    expect(await screen.findByText('Profile saved. Your email address has been changed.')).toBeInTheDocument();
    await waitFor(() => expect(topBarEmail()).toBe('new@example.com'));
    expect(calls('GET /api/auth/me')).toHaveLength(2); // once at start-up, once to refresh after the save
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument(); // no "checking your session" screen
    expect(screen.queryByText('Checking your session…')).not.toBeInTheDocument();
  });

  test('changing only the display name keeps the top bar and the page as they are', async () => {
    render(<App />);
    const form = await screen.findByRole('form', { name: 'Edit profile' });
    type(within(form).getByLabelText('Display name'), 'Sam');
    fireEvent.click(within(form).getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('Profile saved.')).toBeInTheDocument();
    expect(topBarEmail()).toBe('admin@example.com');
  });

  test('after a password change the fresh cookie is confirmed with the server and the person stays signed in', async () => {
    render(<App />);
    const form = await screen.findByRole('form', { name: 'Change password' });
    type(within(form).getByLabelText(/^Current password/), OLD_PASSWORD);
    type(within(form).getByLabelText(/^New password/), NEW_PASSWORD);
    type(within(form).getByLabelText(/^Confirm new password/), NEW_PASSWORD);
    fireEvent.click(within(form).getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText(/Password changed\./)).toBeInTheDocument();
    expect(calls('POST /api/account/password')).toHaveLength(1);
    expect(calls('GET /api/auth/me')).toHaveLength(2); // start-up, then the confirmation after the change
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Administrator sign in' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/test-password/);
  });

  test('if the server says the session is gone right after a password change, the app goes to the login page with a notice', async () => {
    render(<App />);
    const form = await screen.findByRole('form', { name: 'Change password' });
    type(within(form).getByLabelText(/^Current password/), OLD_PASSWORD);
    type(within(form).getByLabelText(/^New password/), NEW_PASSWORD);
    type(within(form).getByLabelText(/^Confirm new password/), NEW_PASSWORD);
    override['POST /api/account/password'] = () => {
      server.signedIn = false; // e.g. the browser refused the new cookie
      return reply({ message: 'Password changed. Other sessions have been signed out.' });
    };
    fireEvent.click(within(form).getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('heading', { name: 'Administrator sign in' })).toBeInTheDocument();
    expect(screen.getByText('Your session has ended. Please sign in again.')).toBeInTheDocument();
  });

  test('if the server can not be reached to confirm the session, the person stays on the page with a warning', async () => {
    render(<App />);
    const form = await screen.findByRole('form', { name: 'Change password' });
    type(within(form).getByLabelText(/^Current password/), OLD_PASSWORD);
    type(within(form).getByLabelText(/^New password/), NEW_PASSWORD);
    type(within(form).getByLabelText(/^Confirm new password/), NEW_PASSWORD);
    let meCalls = 0;
    override['GET /api/auth/me'] = () => {
      meCalls += 1;
      throw new TypeError('offline');
    };
    fireEvent.click(within(form).getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/could not be reached to confirm your session/)).toBeInTheDocument();
    expect(meCalls).toBe(1);
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });

  test('a 401 from a Settings request (the session ran out) sends the person to the login page', async () => {
    render(<App />);
    const form = await screen.findByRole('form', { name: 'Edit profile' });
    override['PATCH /api/account/profile'] = () => reply({ error: 'Authentication required' }, 401);
    type(within(form).getByLabelText('Display name'), 'Sam');
    fireEvent.click(within(form).getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByRole('heading', { name: 'Administrator sign in' })).toBeInTheDocument();
    expect(screen.getByText('Your session has expired. Please sign in again.')).toBeInTheDocument();
  });

  test('a wrong password does not sign the person out (403 is not 401) and does not refresh the session', async () => {
    render(<App />);
    const form = await screen.findByRole('form', { name: 'Change password' });
    override['POST /api/account/password'] = () => reply({ error: 'Current password is incorrect', fields: ['currentPassword'] }, 403);
    type(within(form).getByLabelText(/^Current password/), 'wrong-test-password');
    type(within(form).getByLabelText(/^New password/), NEW_PASSWORD);
    type(within(form).getByLabelText(/^Confirm new password/), NEW_PASSWORD);
    fireEvent.click(within(form).getByRole('button', { name: 'Change password' }));
    expect(await within(form).findByText('That is not your current password.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(calls('GET /api/auth/me')).toHaveLength(1);
  });
});

describe('the Dashboard follows the saved threshold', () => {
  const lowStockPanel = async () => (await screen.findByRole('heading', { name: 'Low stock' })).closest('section');

  test('save a new threshold in Settings, open the Dashboard, and the low-stock panel uses it straight away', async () => {
    window.history.replaceState(null, '', '/');
    render(<App />);
    let panel = await lowStockPanel();
    await within(panel).findByText(/5 or fewer in stock/);
    expect(within(panel).getByText('3', { selector: 'strong' })).toBeInTheDocument(); // stocks 0, 3, 5

    fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
    const form = await screen.findByRole('form', { name: 'Inventory preferences' });
    type(within(form).getByLabelText(/^Low-stock threshold/), '12');
    fireEvent.click(within(form).getByRole('button', { name: 'Save threshold' }));
    expect(await screen.findByText('Low-stock threshold saved: 12.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Dashboard/ }));
    panel = await lowStockPanel();
    await within(panel).findByText(/12 or fewer in stock/);
    expect(within(panel).getByText('5', { selector: 'strong' })).toBeInTheDocument(); // stocks 0, 3, 5, 6, 12
    expect(calls('GET /api/settings').length).toBeGreaterThanOrEqual(2); // the Dashboard asked again; nothing was cached
  });

  test('a threshold already saved before the page opens is used on a direct visit to the Dashboard', async () => {
    window.history.replaceState(null, '', '/');
    server.threshold = 0;
    render(<App />);
    const panel = await lowStockPanel();
    await within(panel).findByText(/0 or fewer in stock/);
    expect(within(panel).getByText('Out of stock')).toBeInTheDocument();
  });
});
