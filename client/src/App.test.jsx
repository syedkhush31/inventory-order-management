// Tests the whole app flow (login, session check, logout) with a fake fetch.
// No backend, database or real network is involved, so these tests do not prove the real server works.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App.jsx';

const ADMIN = { id: 1, email: 'admin@example.com' };

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Gives the fake fetch a reply for each "METHOD /path". Replies can be a Response or an Error to throw.
function mockApi(routes) {
  fetch.mockImplementation(async (url, options = {}) => {
    const key = `${options.method || 'GET'} ${url}`;
    const reply = routes[key];
    if (reply === undefined) throw new Error(`Unexpected request: ${key}`);
    const value = typeof reply === 'function' ? reply() : reply;
    if (value instanceof Error) throw value;
    return value;
  });
}

const callsTo = (key) =>
  fetch.mock.calls.filter(([url, options = {}]) => `${options.method || 'GET'} ${url}` === key);

async function fillAndSubmit(email, password) {
  if (email !== null) fireEvent.change(screen.getByLabelText('Email address'), { target: { value: email } });
  if (password !== null) fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session check on load', () => {
  test('shows the checking screen, then the login page when /me says 401', async () => {
    mockApi({ 'GET /api/auth/me': jsonResponse(401, { error: 'Authentication required' }) });
    render(<App />);
    expect(screen.getByText('Checking your session…')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Administrator sign in' })).toBeInTheDocument();
    expect(callsTo('GET /api/auth/me')[0][1].credentials).toBe('include');
  });

  test('shows the dashboard only after /me confirms the session', async () => {
    mockApi({ 'GET /api/auth/me': jsonResponse(200, { admin: ADMIN }) });
    render(<App />);
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getAllByText(ADMIN.email).length).toBeGreaterThan(0);
  });

  test('a network failure shows an error with Retry, not the login page, and Retry can recover', async () => {
    let attempt = 0;
    mockApi({
      'GET /api/auth/me': () => (attempt++ === 0 ? new TypeError('Failed to fetch') : jsonResponse(200, { admin: ADMIN })),
    });
    render(<App />);
    expect(await screen.findByText('Cannot reach the server')).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  test('a server error (500) is treated as unreachable, not as signed out', async () => {
    mockApi({ 'GET /api/auth/me': jsonResponse(500, { error: 'Internal server error' }) });
    render(<App />);
    expect(await screen.findByText('Cannot reach the server')).toBeInTheDocument();
  });
});

describe('login form', () => {
  beforeEach(async () => {
    mockApi({ 'GET /api/auth/me': jsonResponse(401, { error: 'Authentication required' }) });
  });

  test('has labelled fields and requires both before sending anything', async () => {
    render(<App />);
    await screen.findByLabelText('Email address');

    await fillAndSubmit('', '');
    expect(screen.getByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toHaveFocus();

    await fillAndSubmit('admin@example.com', '');
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveFocus();

    expect(callsTo('POST /api/auth/login')).toHaveLength(0);
  });

  test('successful login: POSTs credentials, verifies with /me, then shows the dashboard', async () => {
    let signedIn = false;
    mockApi({
      'GET /api/auth/me': () =>
        signedIn ? jsonResponse(200, { admin: ADMIN }) : jsonResponse(401, { error: 'Authentication required' }),
      'POST /api/auth/login': () => {
        signedIn = true;
        return jsonResponse(200, { admin: ADMIN });
      },
    });
    render(<App />);
    await screen.findByLabelText('Email address');

    await fillAndSubmit('  admin@example.com ', 'a-long-test-password');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();

    const [, options] = callsTo('POST /api/auth/login')[0];
    expect(options.credentials).toBe('include');
    expect(JSON.parse(options.body)).toEqual({ email: 'admin@example.com', password: 'a-long-test-password' });
    expect(callsTo('GET /api/auth/me')).toHaveLength(2); // once on load, once to verify after login
  });

  test('shows a loading state and disables the button while signing in', async () => {
    let finish;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    mockApi({
      'GET /api/auth/me': jsonResponse(401, { error: 'Authentication required' }),
      'POST /api/auth/login': () => pending,
    });
    render(<App />);
    await screen.findByLabelText('Email address');
    await fillAndSubmit('admin@example.com', 'pw');

    const busyButton = await screen.findByRole('button', { name: 'Signing in…' });
    expect(busyButton).toBeDisabled();
    fireEvent.click(busyButton); // a second click must not send a second request
    expect(callsTo('POST /api/auth/login')).toHaveLength(1);

    finish(jsonResponse(401, { error: 'Invalid email or password' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  test('wrong credentials show one generic error, clear the password and keep the email', async () => {
    mockApi({
      'GET /api/auth/me': jsonResponse(401, { error: 'Authentication required' }),
      'POST /api/auth/login': jsonResponse(401, { error: 'Invalid email or password' }),
    });
    render(<App />);
    await screen.findByLabelText('Email address');
    await fillAndSubmit('admin@example.com', 'wrong-password');

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    expect(screen.getByLabelText('Password')).toHaveFocus();
    expect(screen.getByLabelText('Email address')).toHaveValue('admin@example.com');
  });

  test.each([
    [429, 'Too many sign-in attempts'],
    [400, 'Please check the email address and password'],
    [403, 'The sign-in request was blocked'],
    [500, 'Something went wrong'],
  ])('status %i shows a clear message', async (status, text) => {
    mockApi({
      'GET /api/auth/me': jsonResponse(401, { error: 'Authentication required' }),
      'POST /api/auth/login': jsonResponse(status, { error: 'x' }),
    });
    render(<App />);
    await screen.findByLabelText('Email address');
    await fillAndSubmit('admin@example.com', 'pw');
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  test('a network error during login shows a connection message', async () => {
    mockApi({
      'GET /api/auth/me': jsonResponse(401, { error: 'Authentication required' }),
      'POST /api/auth/login': new TypeError('Failed to fetch'),
    });
    render(<App />);
    await screen.findByLabelText('Email address');
    await fillAndSubmit('admin@example.com', 'pw');
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server');
  });

  test('login that succeeds but is not confirmed by /me does not open the dashboard', async () => {
    mockApi({
      'GET /api/auth/me': jsonResponse(401, { error: 'Authentication required' }),
      'POST /api/auth/login': jsonResponse(200, { admin: ADMIN }),
    });
    render(<App />);
    await screen.findByLabelText('Email address');
    await fillAndSubmit('admin@example.com', 'pw');
    expect(await screen.findByRole('alert')).toHaveTextContent('session could not be verified');
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();
  });

  test('never stores the password or any token in browser storage', async () => {
    let signedIn = false;
    mockApi({
      'GET /api/auth/me': () =>
        signedIn ? jsonResponse(200, { admin: ADMIN }) : jsonResponse(401, { error: 'Authentication required' }),
      'POST /api/auth/login': () => {
        signedIn = true;
        return jsonResponse(200, { admin: ADMIN });
      },
    });
    render(<App />);
    await screen.findByLabelText('Email address');
    await fillAndSubmit('admin@example.com', 'a-long-test-password');
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

describe('dashboard shell and logout', () => {
  test('shows the sidebar sections: Dashboard and Inventory available, the rest disabled, no invented metrics', async () => {
    mockApi({ 'GET /api/auth/me': jsonResponse(200, { admin: ADMIN }) });
    render(<App />);
    await screen.findByRole('heading', { name: 'Dashboard' });

    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav).toHaveTextContent('Inventory');
    expect(screen.getByRole('button', { name: /^Dashboard/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^Inventory/ })).toBeEnabled();
    for (const name of ['Orders', 'Customers', 'Activity', 'Settings']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${name}`) })).toBeDisabled();
    }
    expect(screen.getAllByText('Not built yet')).toHaveLength(4);
    expect(screen.getByText('Available')).toBeInTheDocument();
  });

  test('clicking Inventory opens the inventory page and marks it as the current section', async () => {
    mockApi({
      'GET /api/auth/me': jsonResponse(200, { admin: ADMIN }),
      'GET /api/products?status=active&page=1&pageSize=25&sort=name&order=asc': jsonResponse(200, {
        items: [],
        page: 1,
        pageSize: 25,
        total: 0,
        totalPages: 0,
      }),
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Dashboard' });

    fireEvent.click(screen.getByRole('button', { name: /^Inventory/ }));
    expect(await screen.findByRole('heading', { name: 'Inventory' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Inventory/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: /^Dashboard/ })).not.toHaveAttribute('aria-current');
    expect(await screen.findByText('There are no active products.')).toBeInTheDocument();
  });

  test('Sign out calls the logout endpoint and returns to the login page', async () => {
    let signedIn = true;
    mockApi({
      'GET /api/auth/me': () =>
        signedIn ? jsonResponse(200, { admin: ADMIN }) : jsonResponse(401, { error: 'Authentication required' }),
      'POST /api/auth/logout': () => {
        signedIn = false;
        return jsonResponse(200, { message: 'Logged out' });
      },
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Dashboard' });

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Administrator sign in' })).toBeInTheDocument();
    expect(callsTo('POST /api/auth/logout')[0][1].credentials).toBe('include');
  });

  test('if Sign out fails, the user stays on the dashboard and sees an error', async () => {
    mockApi({
      'GET /api/auth/me': jsonResponse(200, { admin: ADMIN }),
      'POST /api/auth/logout': new TypeError('Failed to fetch'),
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Dashboard' });

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign out failed');
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  });
});
