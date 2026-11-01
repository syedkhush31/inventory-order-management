// The account endpoints under /api/account (all require a signed-in administrator, and only ever act on THAT
// administrator's own account).
import { apiRequest } from './client.js';
import { UnexpectedResponseError } from './products.js';

// A reply that says "ok" but has no account cannot be trusted as a confirmed result.
function accountFrom(data) {
  if (!data || !data.account || typeof data.account.email !== 'string') {
    throw new UnexpectedResponseError();
  }
  return data.account;
}

// GET /api/account  ->  200 { account: { id, email, displayName, createdAt } } (displayName may be null)
export async function getAccount({ signal } = {}) {
  return accountFrom(await apiRequest('/api/account', { signal }));
}

// PATCH /api/account/profile  { displayName?: string | null, email?: string, currentPassword?: string }  ->  200 { account }
// Sends only the fields given. Changing the email needs currentPassword.
// Errors are thrown (ApiError / NetworkError): 400 { fields } for invalid input, 403 { fields: ['currentPassword'] } for a wrong
// current password, 409 { fields: ['email'] } when another account uses the email, 429 after too many wrong passwords.
export async function updateProfile({ displayName, email, currentPassword }) {
  const body = {};
  if (displayName !== undefined) body.displayName = displayName;
  if (email !== undefined) body.email = email;
  if (currentPassword !== undefined) body.currentPassword = currentPassword;
  return accountFrom(await apiRequest('/api/account/profile', { method: 'PATCH', body }));
}

// POST /api/account/password  { currentPassword, newPassword }  ->  200 { message }, and the server sets a NEW login cookie
// (other sessions end). The passwords are only ever sent in this request body: they are not kept anywhere.
// Errors are thrown: 400 { fields }, 403 { fields: ['currentPassword'] } for a wrong current password, 429 after too many.
export async function changePassword({ currentPassword, newPassword }) {
  const data = await apiRequest('/api/account/password', { method: 'POST', body: { currentPassword, newPassword } });
  if (!data || typeof data.message !== 'string') {
    throw new UnexpectedResponseError();
  }
  return data.message;
}
