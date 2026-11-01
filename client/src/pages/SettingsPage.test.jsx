// The Settings page with a fake fetch. Nothing here talks to a real server or database, and no real password exists:
// every password below is a made-up test string. These tests prove how the page behaves with the answers the API is
// documented to give; they do not prove the live API works.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import SettingsPage from './SettingsPage.jsx';

const mockRefreshSession = vi.fn();
vi.mock('../auth/AuthContext.jsx', () => ({
  useAuth: () => ({ admin: { id: 7, email: 'admin@example.com' }, refreshSession: mockRefreshSession }),
}));

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const OLD_PASSWORD = 'old-test-password-A1';
const NEW_PASSWORD = 'new-test-password-B2';

let state; // what the fake server holds
let handlers; // 'METHOD /path' -> (body) => Response (tests replace entries)
let consoleSpies;

function freshState() {
  return {
    account: { id: 7, email: 'admin@example.com', displayName: 'Sam', createdAt: '2026-10-01T09:00:00.000Z' },
    settings: { lowStockThreshold: 5 },
    app: { name: 'ShelfSync', serverVersion: '0.1.0', clientVersion: '0.1.0', environment: 'development' },
  };
}

function defaultHandlers() {
  return {
    'GET /api/account': () => reply({ account: state.account }),
    'GET /api/settings': () => reply({ settings: state.settings, app: state.app }),
    'PATCH /api/account/profile': (body) => {
      state.account = {
        ...state.account,
        ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
        ...(body.email !== undefined ? { email: body.email } : {}),
      };
      return reply({ account: state.account });
    },
    'POST /api/account/password': () => reply({ message: 'Password changed. Other sessions have been signed out.' }),
    'PATCH /api/settings': (body) => {
      state.settings = { lowStockThreshold: body.lowStockThreshold };
      return reply({ settings: state.settings });
    },
  };
}

beforeEach(() => {
  state = freshState();
  handlers = defaultHandlers();
  mockRefreshSession.mockReset().mockResolvedValue('ok');
  localStorage.clear();
  sessionStorage.clear();
  consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options = {}) => {
      const key = `${options.method || 'GET'} ${url}`;
      const handler = handlers[key];
      if (!handler) throw new Error(`Unexpected request: ${key}`);
      return handler(options.body ? JSON.parse(options.body) : undefined);
    })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const calls = (key) => fetch.mock.calls.filter(([url, options = {}]) => `${options.method || 'GET'} ${url}` === key);
const bodyOf = (key, index = 0) => JSON.parse(calls(key)[index][1].body);

async function renderLoaded() {
  render(<SettingsPage />);
  await screen.findByRole('form', { name: 'Edit profile' });
  await screen.findByRole('form', { name: 'Inventory preferences' });
}

const profileForm = () => screen.getByRole('form', { name: 'Edit profile' });
const passwordForm = () => screen.getByRole('form', { name: 'Change password' });
const preferencesForm = () => screen.getByRole('form', { name: 'Inventory preferences' });
const type = (element, value) => fireEvent.change(element, { target: { value } });

// ------------------------------------------------------------------------------------------ loading and sections
describe('loading and the sections', () => {
  test('requests the account and the settings, and shows the four sections', async () => {
    await renderLoaded();
    expect(calls('GET /api/account')).toHaveLength(1);
    expect(calls('GET /api/settings')).toHaveLength(1);
    for (const name of ['Settings', 'Profile', 'Security', 'Inventory preferences', 'Application information']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
  });

  test('shows a loading state before the answers arrive', () => {
    fetch.mockImplementation(() => new Promise(() => {}));
    render(<SettingsPage />);
    expect(screen.getByText('Loading your profile…')).toBeInTheDocument();
    expect(screen.getByText('Loading your preferences…')).toBeInTheDocument();
    expect(screen.getByText('Loading application information…')).toBeInTheDocument();
    // changing the password needs nothing from the server first
    expect(passwordForm()).toBeInTheDocument();
  });

  test('shows the signed-in email, the display name and when the account was created', async () => {
    await renderLoaded();
    const profile = screen.getByRole('heading', { name: 'Profile' }).closest('section');
    expect(within(profile).getByText('Signed in as').nextSibling).toHaveTextContent('admin@example.com');
    expect(within(profile).getByText('Display name', { selector: 'dt' }).nextSibling).toHaveTextContent('Sam');
    expect(within(profile).getByText('Account created').nextSibling).toHaveTextContent(/2026/);
  });

  test('a display name that was never set is shown as Not set', async () => {
    state.account.displayName = null;
    await renderLoaded();
    expect(screen.getByText('Not set')).toBeInTheDocument();
    expect(within(profileForm()).getByLabelText('Display name')).toHaveValue('');
  });

  test('if the profile cannot be loaded that section says so with a retry, and the others still work', async () => {
    handlers['GET /api/account'] = () => reply({ error: 'x' }, 500);
    render(<SettingsPage />);
    expect(await screen.findByText('Your profile could not be loaded.')).toBeInTheDocument();
    expect(await screen.findByRole('form', { name: 'Inventory preferences' })).toBeInTheDocument();
    expect(passwordForm()).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Edit profile' })).not.toBeInTheDocument();

    handlers['GET /api/account'] = () => reply({ account: state.account });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('form', { name: 'Edit profile' })).toBeInTheDocument();
  });

  test('if the settings cannot be loaded the preferences and the application information say so, and the profile still works', async () => {
    handlers['GET /api/settings'] = () => reply({ error: 'x' }, 500);
    render(<SettingsPage />);
    expect(await screen.findByText('Your preferences could not be loaded.')).toBeInTheDocument();
    expect(screen.getByText('Application information could not be loaded.')).toBeInTheDocument();
    expect(await screen.findByRole('form', { name: 'Edit profile' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Inventory preferences' })).not.toBeInTheDocument();

    handlers['GET /api/settings'] = () => reply({ settings: state.settings, app: state.app });
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]);
    expect(await screen.findByRole('form', { name: 'Inventory preferences' })).toBeInTheDocument();
    expect(screen.getByText('Server version')).toBeInTheDocument();
  });

  test('a reply that is not what the API promises is an error, not an empty or made-up page', async () => {
    handlers['GET /api/settings'] = () => reply({ settings: { lowStockThreshold: 'five' }, app: state.app });
    handlers['GET /api/account'] = () => reply({ account: null });
    render(<SettingsPage />);
    expect(await screen.findByText('Your profile could not be loaded.')).toBeInTheDocument();
    expect(await screen.findByText('Your preferences could not be loaded.')).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------------------------ application information
describe('application information', () => {
  test('shows exactly what the server reported', async () => {
    state.app = { name: 'ShelfSync', serverVersion: '1.2.3', clientVersion: '0.4.5', environment: 'production' };
    await renderLoaded();
    const info = screen.getByRole('heading', { name: 'Application information' }).closest('section');
    expect(within(info).getByText('Application').nextSibling).toHaveTextContent('ShelfSync');
    expect(within(info).getByText('Client version').nextSibling).toHaveTextContent('0.4.5');
    expect(within(info).getByText('Server version').nextSibling).toHaveTextContent('1.2.3');
    expect(within(info).getByText('Environment').nextSibling).toHaveTextContent('Production');
  });

  test('the development environment is labelled Development', async () => {
    await renderLoaded();
    const info = screen.getByRole('heading', { name: 'Application information' }).closest('section');
    expect(within(info).getByText('Environment').nextSibling).toHaveTextContent('Development');
  });

  test('a version the server could not read is Not available, never an invented number', async () => {
    state.app = { name: 'ShelfSync', serverVersion: null, clientVersion: null, environment: 'development' };
    await renderLoaded();
    const info = screen.getByRole('heading', { name: 'Application information' }).closest('section');
    expect(within(info).getByText('Client version').nextSibling).toHaveTextContent('Not available');
    expect(within(info).getByText('Server version').nextSibling).toHaveTextContent('Not available');
    expect(info.textContent).not.toMatch(/\d+\.\d+\.\d+/);
  });

  test('an unexpected environment value is shown as received, and missing fields as Not available', async () => {
    state.app = { name: '', serverVersion: '0.1.0', environment: 'staging' };
    await renderLoaded();
    const info = screen.getByRole('heading', { name: 'Application information' }).closest('section');
    expect(within(info).getByText('Application').nextSibling).toHaveTextContent('Not available');
    expect(within(info).getByText('Environment').nextSibling).toHaveTextContent('staging');
  });

  test('shows no secret, database or connection detail (only what the four fields carry)', async () => {
    await renderLoaded();
    const info = screen.getByRole('heading', { name: 'Application information' }).closest('section');
    expect(info.textContent).not.toMatch(/password|secret|database|mysql|jwt|token|localhost|inventory_/i);
  });
});

// ------------------------------------------------------------------------------------------ profile
describe('profile: display name', () => {
  test('saves a changed display name, sends only that field, shows the result and refreshes the session', async () => {
    await renderLoaded();
    expect(within(profileForm()).queryByLabelText(/Current password/)).not.toBeInTheDocument(); // not needed for a name
    type(within(profileForm()).getByLabelText('Display name'), '  Sam Lee ');
    fireEvent.click(within(profileForm()).getByRole('button', { name: 'Save profile' }));

    expect(await screen.findByText('Profile saved.')).toBeInTheDocument();
    expect(bodyOf('PATCH /api/account/profile')).toEqual({ displayName: 'Sam Lee' });
    expect(within(profileForm()).getByLabelText('Display name')).toHaveValue('Sam Lee');
    expect(screen.getByText('Display name', { selector: 'dt' }).nextSibling).toHaveTextContent('Sam Lee');
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
  });

  test('clearing the display name sends null', async () => {
    await renderLoaded();
    type(within(profileForm()).getByLabelText('Display name'), '   ');
    fireEvent.click(within(profileForm()).getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('Profile saved.')).toBeInTheDocument();
    expect(bodyOf('PATCH /api/account/profile')).toEqual({ displayName: null });
    expect(screen.getByText('Not set')).toBeInTheDocument();
  });

  test('saving without changing anything sends nothing and says so', async () => {
    await renderLoaded();
    fireEvent.click(within(profileForm()).getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing has changed yet');
    expect(calls('PATCH /api/account/profile')).toHaveLength(0);
  });

  test.each([
    ['too long', 'x'.repeat(101), /100 characters/],
    ['with a control character', 'bad\u0007name', /control characters/],
  ])('a display name that is %s is refused before anything is sent', async (_label, value, message) => {
    await renderLoaded();
    type(within(profileForm()).getByLabelText('Display name'), value);
    fireEvent.click(within(profileForm()).getByRole('button', { name: 'Save profile' }));
    expect(await within(profileForm()).findByText(message, { selector: '.field__error' })).toBeInTheDocument();
    expect(calls('PATCH /api/account/profile')).toHaveLength(0);
  });
});

describe('profile: email', () => {
  const openEmailChange = async (email = 'new@example.com') => {
    await renderLoaded();
    type(within(profileForm()).getByLabelText('Email address'), email);
  };

  test('the password field appears only while the email is being changed', async () => {
    await renderLoaded();
    const email = within(profileForm()).getByLabelText('Email address');
    expect(within(profileForm()).queryByLabelText(/Current password/)).not.toBeInTheDocument();
    type(email, 'new@example.com');
    expect(within(profileForm()).getByLabelText(/Current password/)).toBeInTheDocument();
    type(email, 'admin@example.com');
    expect(within(profileForm()).queryByLabelText(/Current password/)).not.toBeInTheDocument();
    type(email, '  ADMIN@Example.com '); // the same address written differently
    expect(within(profileForm()).queryByLabelText(/Current password/)).not.toBeInTheDocument();
  });

  test('changing the email without the password is refused before anything is sent', async () => {
    await openEmailChange();
    fireEvent.click(within(profileForm()).getByRole('button', { name: 'Save profile' }));
    expect(await within(profileForm()).findByText('Enter your current password to change your email address.')).toBeInTheDocument();
    expect(calls('PATCH /api/account/profile')).toHaveLength(0);
  });

  test('a badly formed email is refused before anything is sent', async () => {
    await openEmailChange('not-an-email');
    type(within(profileForm()).getByLabelText(/Current password/), OLD_PASSWORD);
    fireEvent.click(within(profileForm()).getByRole('button', { name: 'Save profile' }));
    expect(await within(profileForm()).findByText(/valid email address/)).toBeInTheDocument();
    expect(calls('PATCH /api/account/profile')).toHaveLength(0);
  });

  test('saves the new email with the current password, then clears the password and refreshes the session', async () => {
    await openEmailChange('  NEW@Example.COM ');
    type(within(profileForm()).getByLabelText(/Current password/), OLD_PASSWORD);
    fireEvent.click(within(profileForm()).getByRole('button', { name: 'Save profile' }));

    expect(await screen.findByText('Profile saved. Your email address has been changed.')).toBeInTheDocument();
    expect(bodyOf('PATCH /api/account/profile')).toEqual({ email: 'new@example.com', currentPassword: OLD_PASSWORD });
    expect(within(profileForm()).getByLabelText('Email address')).toHaveValue('new@example.com');
    expect(within(profileForm()).queryByLabelText(/Current password/)).not.toBeInTheDocument(); // gone with the saved state
    expect(screen.getByText('Signed in as').nextSibling).toHaveTextContent('new@example.com');
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
  });

  test('email and display name together are sent in one request', async () => {
    await openEmailChange();
    type(within(profileForm()).getByLabelText('Display name'), 'Other');
    type(within(profileForm()).getByLabelText(/Current password/), OLD_PASSWORD);
    fireEvent.click(within(profileForm()).getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved. Your email address has been changed.');
    expect(bodyOf('PATCH /api/account/profile')).toEqual({ displayName: 'Other', email: 'new@example.com', currentPassword: OLD_PASSWORD });
  });

  test('a wrong password (403) is shown on the password field, the password is cleared, and nothing is saved', async () => {
    handlers['PATCH /api/account/profile'] = () => reply({ error: 'Current password is incorrect', fields: ['currentPassword'] }, 403);
    await openEmailChange();
    type(within(profileForm()).getByLabelText(/Current password/), 'wrong-test-password');
    fireEvent.click(within(profileForm()).getByRole('button', { name: 'Save profile' }));

    expect(await within(profileForm()).findByText('That is not your current password.')).toBeInTheDocument();
    expect(within(profileForm()).getByLabelText(/Current password/)).toHaveValue('');
    expect(within(profileForm()).getByLabelText(/Current password/)).toHaveFocus();
    expect(screen.getByText('Signed in as').nextSibling).toHaveTextContent('admin@example.com'); // still the old address
    expect(screen.queryByText(/Profile saved/)).not.toBeInTheDocument();
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });

  test('a duplicate email (409) is shown on the email field and the form stays filled in', async () => {
    handlers['PATCH /api/account/profile'] = () => reply({ error: 'Another account already uses this email', fields: ['email'] }, 409);
    await openEmailChange('taken@example.com');
    type(within(profileForm()).getByLabelText(/Current password/), OLD_PASSWORD);
    fireEvent.click(within(profileForm()).getByRole('button', { name: 'Save profile' }));

    expect(await within(profileForm()).findByText(/Another account already uses this email address/)).toBeInTheDocument();
    expect(within(profileForm()).getByLabelText('Email address')).toHaveValue('taken@example.com');
    expect(within(profileForm()).getByLabelText('Email address')).toHaveFocus();
    expect(screen.queryByText(/Profile saved/)).not.toBeInTheDocument();
  });

  test('too many wrong attempts (429) explains the wait', async () => {
    handlers['PATCH /api/account/profile'] = () => reply({ error: 'Too many incorrect password attempts. Please try again later.' }, 429);
    await openEmailChange();
    type(within(profileForm()).getByLabelText(/Current password/), OLD_PASSWORD);
    fireEvent.click(within(profileForm()).getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many incorrect password attempts. Please wait a few minutes');
    expect(within(profileForm()).getByLabelText(/Current password/)).toHaveValue('');
  });

  test('server validation errors (400) are shown against the fields the server named', async () => {
    handlers['PATCH /api/account/profile'] = () => reply({ error: 'Invalid request', fields: ['email', 'displayName'] }, 400);
    await openEmailChange();
    type(within(profileForm()).getByLabelText(/Current password/), OLD_PASSWORD);
    fireEvent.click(within(profileForm()).getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('some details were not accepted');
    expect(within(profileForm()).getAllByText('The server did not accept this value. Please check it.')).toHaveLength(2);
  });

  test('a lost connection says the change may not have been saved', async () => {
    handlers['PATCH /api/account/profile'] = () => {
      throw new TypeError('offline');
    };
    await openEmailChange();
    type(within(profileForm()).getByLabelText(/Current password/), OLD_PASSWORD);
    fireEvent.click(within(profileForm()).getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('your changes may not have been saved');
  });

  test('a 200 reply without the account is reported as unconfirmed, not as saved', async () => {
    handlers['PATCH /api/account/profile'] = () => reply({ ok: true });
    await openEmailChange();
    type(within(profileForm()).getByLabelText(/Current password/), OLD_PASSWORD);
    fireEvent.click(within(profileForm()).getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('may or may not have been saved');
    expect(screen.queryByText(/Profile saved/)).not.toBeInTheDocument();
  });

  test('if the session can not be refreshed afterwards the save still shows as saved, with a gentle warning', async () => {
    mockRefreshSession.mockResolvedValue('unreachable');
    await openEmailChange();
    type(within(profileForm()).getByLabelText(/Current password/), OLD_PASSWORD);
    fireEvent.click(within(profileForm()).getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByText('Profile saved. Your email address has been changed.')).toBeInTheDocument();
    expect(screen.getByText(/could not be refreshed/)).toBeInTheDocument();
  });

  test('while saving the button is disabled and a second press sends nothing more', async () => {
    let finish;
    handlers['PATCH /api/account/profile'] = (body) =>
      new Promise((resolve) => {
        finish = () => {
          state.account = { ...state.account, displayName: body.displayName };
          resolve(reply({ account: state.account }));
        };
      });
    await renderLoaded();
    type(within(profileForm()).getByLabelText('Display name'), 'Slow');
    const form = profileForm();
    fireEvent.click(within(form).getByRole('button', { name: 'Save profile' }));
    const busy = await within(form).findByRole('button', { name: 'Saving…' });
    expect(busy).toBeDisabled();
    expect(within(form).getByLabelText('Display name')).toBeDisabled();
    fireEvent.submit(form);
    fireEvent.click(busy);
    expect(calls('PATCH /api/account/profile')).toHaveLength(1);
    finish();
    expect(await screen.findByText('Profile saved.')).toBeInTheDocument();
    expect(calls('PATCH /api/account/profile')).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------ security
describe('security: change password', () => {
  const fill = ({ current = OLD_PASSWORD, next = NEW_PASSWORD, confirm = NEW_PASSWORD } = {}) => {
    const form = passwordForm();
    type(within(form).getByLabelText(/^Current password/), current);
    type(within(form).getByLabelText(/^New password/), next);
    type(within(form).getByLabelText(/^Confirm new password/), confirm);
  };
  const submit = () => fireEvent.click(within(passwordForm()).getByRole('button', { name: 'Change password' }));

  test('the three boxes are password fields with the right autocomplete hints', async () => {
    await renderLoaded();
    const form = passwordForm();
    for (const [label, autocomplete] of [[/^Current password/, 'current-password'], [/^New password/, 'new-password'], [/^Confirm new password/, 'new-password']]) {
      const input = within(form).getByLabelText(label);
      expect(input).toHaveAttribute('type', 'password');
      expect(input).toHaveAttribute('autocomplete', autocomplete);
    }
  });

  test('changes the password: sends only the current and new password once, clears the boxes, confirms the session', async () => {
    await renderLoaded();
    fill();
    submit();
    expect(await screen.findByText(/Password changed\. Any other devices or browsers that were signed in have been signed out\./)).toBeInTheDocument();
    expect(calls('POST /api/account/password')).toHaveLength(1);
    expect(bodyOf('POST /api/account/password')).toEqual({ currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD }); // not the confirmation
    for (const label of [/^Current password/, /^New password/, /^Confirm new password/]) {
      expect(within(passwordForm()).getByLabelText(label)).toHaveValue('');
    }
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(OLD_PASSWORD);
    expect(document.body.textContent).not.toContain(NEW_PASSWORD);
  });

  test('if the session can not be confirmed afterwards the change still shows as done, with a warning', async () => {
    mockRefreshSession.mockResolvedValue('unreachable');
    await renderLoaded();
    fill();
    submit();
    expect(await screen.findByText(/Password changed\./)).toBeInTheDocument();
    expect(screen.getByText(/could not be reached to confirm your session/)).toBeInTheDocument();
  });

  test.each([
    ['all three empty', { current: '', next: '', confirm: '' }, ['Enter your current password.', 'Enter a new password.', 'Type the new password again to confirm it.']],
    ['a new password under 12 characters', { next: 'short-pass1', confirm: 'short-pass1' }, ['The new password must be at least 12 characters.']],
    ['a confirmation that does not match', { confirm: `${NEW_PASSWORD}x` }, ['The two new passwords do not match.']],
    ['a new password equal to the current one', { next: OLD_PASSWORD, confirm: OLD_PASSWORD }, ['The new password must be different from the current one.']],
    ['a new password over 72 bytes', { next: 'x'.repeat(73), confirm: 'x'.repeat(73) }, [/too long/]],
  ])('%s is refused before anything is sent', async (_label, values, messages) => {
    await renderLoaded();
    fill(values);
    submit();
    for (const message of messages) expect(await within(passwordForm()).findByText(message)).toBeInTheDocument();
    expect(calls('POST /api/account/password')).toHaveLength(0);
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });

  test('a wrong current password (403) is shown on that field and that box is cleared; nothing else changes', async () => {
    handlers['POST /api/account/password'] = () => reply({ error: 'Current password is incorrect', fields: ['currentPassword'] }, 403);
    await renderLoaded();
    fill({ current: 'wrong-test-password' });
    submit();
    expect(await within(passwordForm()).findByText('That is not your current password.')).toBeInTheDocument();
    expect(within(passwordForm()).getByLabelText(/^Current password/)).toHaveValue('');
    expect(within(passwordForm()).getByLabelText(/^Current password/)).toHaveFocus();
    expect(within(passwordForm()).getByLabelText(/^New password/)).toHaveValue(NEW_PASSWORD);
    expect(screen.queryByText(/Password changed/)).not.toBeInTheDocument();
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });

  test('too many wrong attempts (429) explains the wait and never claims success', async () => {
    handlers['POST /api/account/password'] = () => reply({ error: 'Too many incorrect password attempts. Please try again later.' }, 429);
    await renderLoaded();
    fill();
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many incorrect password attempts. Please wait a few minutes');
    expect(screen.queryByText(/Password changed/)).not.toBeInTheDocument();
  });

  test('server validation errors (400) are shown against the named fields', async () => {
    handlers['POST /api/account/password'] = () => reply({ error: 'Invalid request', fields: ['newPassword'] }, 400);
    await renderLoaded();
    fill();
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('The password was not changed');
    expect(within(passwordForm()).getByText('The server did not accept this value. Please check it.')).toBeInTheDocument();
  });

  test('a lost connection says the password may not have been changed', async () => {
    handlers['POST /api/account/password'] = () => {
      throw new TypeError('offline');
    };
    await renderLoaded();
    fill();
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('the password may not have been changed');
    expect(screen.queryByText(/Password changed\./)).not.toBeInTheDocument();
  });

  test('a 200 reply without a message is reported as unconfirmed', async () => {
    handlers['POST /api/account/password'] = () => reply({});
    await renderLoaded();
    fill();
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('may or may not have been changed');
  });

  test('while changing the password the button and boxes are disabled and a second press sends nothing more', async () => {
    let finish;
    handlers['POST /api/account/password'] = () =>
      new Promise((resolve) => {
        finish = () => resolve(reply({ message: 'Password changed. Other sessions have been signed out.' }));
      });
    await renderLoaded();
    fill();
    const form = passwordForm();
    submit();
    const busy = await within(form).findByRole('button', { name: 'Changing password…' });
    expect(busy).toBeDisabled();
    expect(within(form).getByLabelText(/^New password/)).toBeDisabled();
    fireEvent.submit(form);
    fireEvent.click(busy);
    expect(calls('POST /api/account/password')).toHaveLength(1);
    finish();
    await screen.findByText(/Password changed\./);
    expect(calls('POST /api/account/password')).toHaveLength(1);
  });

  test('passwords are never stored in the browser, the address or the console', async () => {
    window.history.replaceState(null, '', '/settings');
    await renderLoaded();
    fill();
    submit();
    await screen.findByText(/Password changed\./);
    for (const store of [localStorage, sessionStorage]) {
      expect(store.length).toBe(0);
      expect(JSON.stringify({ ...store })).not.toMatch(/test-password/);
    }
    expect(window.location.href).not.toMatch(/test-password/);
    for (const spy of consoleSpies) expect(JSON.stringify(spy.mock.calls)).not.toMatch(/test-password/);
    // and the wrong-password path
    handlers['POST /api/account/password'] = () => reply({ error: 'x', fields: ['currentPassword'] }, 403);
    fill({ current: 'another-test-password-C3' });
    submit();
    await within(passwordForm()).findByText('That is not your current password.');
    expect(JSON.stringify(consoleSpies.map((spy) => spy.mock.calls))).not.toMatch(/test-password/);
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------ preferences
describe('inventory preferences: low-stock threshold', () => {
  const threshold = () => within(preferencesForm()).getByLabelText(/^Low-stock threshold/);
  const save = () => fireEvent.click(within(preferencesForm()).getByRole('button', { name: 'Save threshold' }));

  test('shows the saved value, and 5 when that is what the server reports', async () => {
    await renderLoaded();
    expect(threshold()).toHaveValue('5');
    expect(screen.getByText(/The standard value is 5\./)).toBeInTheDocument();
  });

  test('shows a saved value other than the default', async () => {
    state.settings.lowStockThreshold = 12;
    await renderLoaded();
    expect(threshold()).toHaveValue('12');
  });

  test('the Save button is off until the value changes, and off again after it is put back', async () => {
    await renderLoaded();
    const button = within(preferencesForm()).getByRole('button', { name: 'Save threshold' });
    expect(button).toBeDisabled();
    type(threshold(), '8');
    expect(button).toBeEnabled();
    type(threshold(), '5');
    expect(button).toBeDisabled();
  });

  test('saves a new value as a number, shows it, and the button goes off again', async () => {
    await renderLoaded();
    type(threshold(), ' 20 ');
    save();
    expect(await screen.findByText('Low-stock threshold saved: 20.')).toBeInTheDocument();
    expect(bodyOf('PATCH /api/settings')).toEqual({ lowStockThreshold: 20 });
    expect(typeof bodyOf('PATCH /api/settings').lowStockThreshold).toBe('number');
    expect(threshold()).toHaveValue('20');
    expect(within(preferencesForm()).getByRole('button', { name: 'Save threshold' })).toBeDisabled();
  });

  test.each([0, 1000])('%i, the edge of the range, can be saved', async (value) => {
    await renderLoaded();
    type(threshold(), String(value));
    save();
    expect(await screen.findByText(`Low-stock threshold saved: ${value}.`)).toBeInTheDocument();
    expect(bodyOf('PATCH /api/settings')).toEqual({ lowStockThreshold: value });
  });

  test.each([
    ['empty', ''],
    ['negative', '-1'],
    ['a decimal', '1.5'],
    ['letters', 'abc'],
    ['over the maximum', '1001'],
    ['an exponent', '1e3'],
  ])('%s is refused before anything is sent', async (_label, value) => {
    await renderLoaded();
    type(threshold(), value);
    save();
    expect(await within(preferencesForm()).findByText(/whole number|between/, { selector: '.field__error' })).toBeInTheDocument();
    expect(calls('PATCH /api/settings')).toHaveLength(0);
    expect(threshold()).toHaveAttribute('aria-invalid', 'true');
  });

  test('the error disappears as soon as the value is edited', async () => {
    await renderLoaded();
    type(threshold(), 'abc');
    save();
    await within(preferencesForm()).findByText(/whole number/, { selector: '.field__error' });
    type(threshold(), '9');
    expect(within(preferencesForm()).queryByText(/whole number/, { selector: '.field__error' })).not.toBeInTheDocument();
  });

  test('a server rejection (400) is shown on the field', async () => {
    handlers['PATCH /api/settings'] = () => reply({ error: 'Invalid request', fields: ['lowStockThreshold'] }, 400);
    await renderLoaded();
    type(threshold(), '8');
    save();
    expect(await within(preferencesForm()).findByText(/The server did not accept this value/)).toBeInTheDocument();
    expect(screen.queryByText(/saved:/)).not.toBeInTheDocument();
  });

  test('a lost connection says the value may not have been saved, and the field keeps what was typed', async () => {
    handlers['PATCH /api/settings'] = () => {
      throw new TypeError('offline');
    };
    await renderLoaded();
    type(threshold(), '8');
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('may not have been saved');
    expect(threshold()).toHaveValue('8');
  });

  test('a 200 reply without the saved value is reported as unconfirmed', async () => {
    handlers['PATCH /api/settings'] = () => reply({});
    await renderLoaded();
    type(threshold(), '8');
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('may or may not have been saved');
  });

  test('a server error (500) gives a general failure message', async () => {
    handlers['PATCH /api/settings'] = () => reply({ error: 'Internal server error' }, 500);
    await renderLoaded();
    type(threshold(), '8');
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('the threshold was not saved');
  });

  test('while saving the button and field are disabled and a second press sends nothing more', async () => {
    let finish;
    handlers['PATCH /api/settings'] = (body) =>
      new Promise((resolve) => {
        finish = () => {
          state.settings = { lowStockThreshold: body.lowStockThreshold };
          resolve(reply({ settings: state.settings }));
        };
      });
    await renderLoaded();
    type(threshold(), '8');
    const form = preferencesForm();
    save();
    const busy = await within(form).findByRole('button', { name: 'Saving…' });
    expect(busy).toBeDisabled();
    expect(threshold()).toBeDisabled();
    fireEvent.submit(form);
    fireEvent.click(busy);
    expect(calls('PATCH /api/settings')).toHaveLength(1);
    finish();
    expect(await screen.findByText('Low-stock threshold saved: 8.')).toBeInTheDocument();
    expect(calls('PATCH /api/settings')).toHaveLength(1);
  });

  test('saving the threshold leaves the other sections alone', async () => {
    await renderLoaded();
    type(threshold(), '8');
    save();
    await screen.findByText('Low-stock threshold saved: 8.');
    expect(calls('PATCH /api/account/profile')).toHaveLength(0);
    expect(calls('POST /api/account/password')).toHaveLength(0);
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });
});
