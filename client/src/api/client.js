// One small wrapper around fetch(), used by every API call.
// - Always sends cookies (credentials: 'include'), which is how the login session works.
// - Never reads or writes localStorage/sessionStorage: the session lives in an HttpOnly cookie.
// - Turns failures into two clear error types: ApiError (server replied) and NetworkError (no reply).

// Empty by default, so calls like "/api/auth/me" go through the Vite dev proxy to the Express server.
// Set VITE_API_BASE_URL only if the API lives at a different address. It must never contain secrets.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

export class ApiError extends Error {
  constructor(status, body) {
    super(`Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export class NetworkError extends Error {
  constructor() {
    super('Could not reach the server');
    this.name = 'NetworkError';
  }
}

let unauthorizedHandler = null;

// The app registers a function here that sends the user back to the login page.
export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler;
}

// notifyOn401: when true, a 401 reply tells the app the session has ended (used by future data calls).
// The auth calls themselves turn it off because they handle 401 on their own.
// signal: optional AbortController signal, used to cancel a request that is no longer needed.
export async function apiRequest(path, { method = 'GET', body, notifyOn401 = true, signal } = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw err; // a deliberate cancel, not a network problem
    }
    throw new NetworkError();
  }

  let data = null;
  try {
    data = await response.json();
  } catch (err) {
    // Not JSON (or empty): leave data as null.
  }

  if (!response.ok) {
    if (response.status === 401 && notifyOn401 && unauthorizedHandler) {
      unauthorizedHandler();
    }
    throw new ApiError(response.status, data);
  }
  return data;
}
