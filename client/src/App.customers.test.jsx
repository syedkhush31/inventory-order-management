// Opening the Customers page from the sidebar, and what happens when the session ends, with a fake fetch.
// No backend, database or real network is involved.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import App from './App.jsx';

const ADMIN = { id: 1, email: 'admin@example.com' };
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const LIST_URL = '/api/customers?status=active&page=1&pageSize=25&sort=name&order=asc';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('clicking Customers opens the customers page and marks it as the current section', async () => {
  fetch.mockImplementation(async (url) => {
    if (url === '/api/auth/me') return json(200, { admin: ADMIN });
    if (url === LIST_URL) return json(200, { items: [], page: 1, pageSize: 25, total: 0, totalPages: 0 });
    throw new Error(`Unexpected request: ${url}`);
  });
  render(<App />);
  await screen.findByRole('heading', { name: 'Dashboard' });

  fireEvent.click(screen.getByRole('button', { name: /^Customers/ }));
  expect(await screen.findByRole('heading', { name: 'Customers' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Customers/ })).toHaveAttribute('aria-current', 'page');
  expect(await screen.findByText(/There are no active customers yet/)).toBeInTheDocument();
});

test('if the session has ended, loading customers returns the user to the login page', async () => {
  fetch.mockImplementation(async (url) => {
    if (url === '/api/auth/me') return json(200, { admin: ADMIN });
    if (url === LIST_URL) return json(401, { error: 'Authentication required' });
    throw new Error(`Unexpected request: ${url}`);
  });
  render(<App />);
  await screen.findByRole('heading', { name: 'Dashboard' });

  fireEvent.click(screen.getByRole('button', { name: /^Customers/ }));
  expect(await screen.findByRole('heading', { name: 'Administrator sign in' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Customers' })).not.toBeInTheDocument();
});
