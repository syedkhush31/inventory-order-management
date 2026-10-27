// The three existing backend authentication endpoints.
import { apiRequest, ApiError } from './client.js';

// POST /api/auth/login  { email, password }  ->  200 { admin: { id, email } } + session cookie
export async function login(email, password) {
  const data = await apiRequest('/api/auth/login', {
    method: 'POST',
    body: { email, password },
    notifyOn401: false,
  });
  return data.admin;
}

// GET /api/auth/me  ->  200 { admin: { id, email } }, or 401 when there is no valid session.
// Returns the admin, or null when nobody is signed in. Other failures are thrown.
export async function getCurrentAdmin() {
  try {
    const data = await apiRequest('/api/auth/me', { notifyOn401: false });
    return data.admin;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return null;
    }
    throw err;
  }
}

// POST /api/auth/logout  ->  200 { message }, and the server clears the cookie.
export async function logout() {
  await apiRequest('/api/auth/logout', { method: 'POST', notifyOn401: false });
}
