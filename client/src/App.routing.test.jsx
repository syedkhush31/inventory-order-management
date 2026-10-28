// The address bar decides which page opens, so refreshing or opening a link keeps the page.
// A fake fetch stands in for the server; no backend or database is involved.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import App from './App.jsx';
import { sectionFromPath } from './hooks/useSectionRoute.js';

const ADMIN = { id: 1, email: 'admin@example.com' };
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const empty = { items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 };

function serve({ signedIn = true } = {}) {
  fetch.mockImplementation(async (url) => {
    if (url === '/api/auth/me') return signedIn ? json(200, { admin: ADMIN }) : json(401, { error: 'Authentication required' });
    if (String(url).startsWith('/api/customers') || String(url).startsWith('/api/products')) return json(200, empty);
    throw new Error(`Unexpected request: ${url}`);
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('sectionFromPath knows the supported paths and ignores a trailing slash', () => {
  expect(sectionFromPath('/')).toBe('dashboard');
  expect(sectionFromPath('/inventory')).toBe('inventory');
  expect(sectionFromPath('/customers/')).toBe('customers');
  expect(sectionFromPath('/orders')).toBeNull();
  expect(sectionFromPath('/customers/1')).toBeNull();
  expect(sectionFromPath('/Customers')).toBeNull();
});

test.each([
  ['/customers', 'Customers'],
  ['/inventory', 'Inventory'],
])('opening %s directly (a refresh) shows that page when signed in', async (path, heading) => {
  window.history.replaceState(null, '', path);
  serve();
  render(<App />);
  expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
  expect(window.location.pathname).toBe(path);
  expect(screen.getByRole('button', { name: new RegExp(`^${heading}`) })).toHaveAttribute('aria-current', 'page');
});

test('clicking a sidebar item updates the address, and Back returns to the previous page', async () => {
  serve();
  render(<App />);
  await screen.findByRole('heading', { name: 'Dashboard' });

  fireEvent.click(screen.getByRole('button', { name: /^Customers/ }));
  expect(await screen.findByRole('heading', { name: 'Customers' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/customers');

  fireEvent.click(screen.getByRole('button', { name: /^Inventory/ }));
  expect(await screen.findByRole('heading', { name: 'Inventory' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/inventory');

  window.history.back();
  expect(await screen.findByRole('heading', { name: 'Customers' })).toBeInTheDocument();
});

test('an unknown path shows the Dashboard and the address is corrected', async () => {
  window.history.replaceState(null, '', '/no-such-page');
  serve();
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/');
});

test('a protected path without a session shows the login page and no data is requested', async () => {
  window.history.replaceState(null, '', '/customers');
  serve({ signedIn: false });
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Administrator sign in' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Customers' })).not.toBeInTheDocument();
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/auth/me']);
});

test('if the session ends on a refreshed page, the login page replaces it', async () => {
  window.history.replaceState(null, '', '/customers');
  fetch.mockImplementation(async (url) => {
    if (url === '/api/auth/me') return json(200, { admin: ADMIN });
    return json(401, { error: 'Authentication required' });
  });
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Administrator sign in' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Customers' })).not.toBeInTheDocument();
});
