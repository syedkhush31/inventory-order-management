// Keeps track of who is signed in, and shares it with the whole app.
// status is one of:
//   'checking'        asking the server GET /api/auth/me
//   'authenticated'   the server confirmed the session
//   'unauthenticated' no valid session: show the login page
//   'unreachable'     the server could not be reached (this is NOT treated as being signed out)
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getCurrentAdmin, login, logout } from '../api/auth.js';
import { setUnauthorizedHandler } from '../api/client.js';

// Thrown when login succeeded but the follow-up GET /me did not confirm the session
// (for example because the browser blocked the cookie).
export class SessionVerificationError extends Error {
  constructor() {
    super('Session could not be verified');
    this.name = 'SessionVerificationError';
  }
}

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [status, setStatus] = useState('checking');
  const [admin, setAdmin] = useState(null);
  const [notice, setNotice] = useState('');
  // Counts requests so that an old, slower answer can never overwrite a newer one.
  const latestRequest = useRef(0);

  const checkSession = useCallback(async () => {
    const requestId = ++latestRequest.current;
    setStatus('checking');
    try {
      const current = await getCurrentAdmin();
      if (requestId !== latestRequest.current) return;
      setAdmin(current);
      setStatus(current ? 'authenticated' : 'unauthenticated');
    } catch (err) {
      if (requestId !== latestRequest.current) return;
      setAdmin(null);
      setStatus('unreachable');
    }
  }, []);

  // Verify the session when the app loads or the page is refreshed.
  useEffect(() => {
    checkSession();
    return () => {
      latestRequest.current += 1;
    };
  }, [checkSession]);

  // If any later API call gets a 401 (for example the 1-hour session ran out), go back to login.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      latestRequest.current += 1;
      setAdmin(null);
      setNotice('Your session has expired. Please sign in again.');
      setStatus('unauthenticated');
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const signIn = useCallback(async (email, password) => {
    await login(email, password);
    // Do not trust the login reply alone: confirm the cookie really works.
    const current = await getCurrentAdmin();
    if (!current) {
      throw new SessionVerificationError();
    }
    latestRequest.current += 1;
    setNotice('');
    setAdmin(current);
    setStatus('authenticated');
  }, []);

  // Re-reads who is signed in WITHOUT the full-screen "checking" state, so the page the person is on keeps its content.
  // Used after the Settings page changes the email or the password: the server has put a fresh login cookie in the
  // browser, and this confirms that it works and refreshes the email shown in the top bar.
  // Resolves to 'ok', 'ended' (the server says nobody is signed in: the app goes to the login page) or
  // 'unreachable' (the server could not be reached: nothing changes, the person stays where they are).
  const refreshSession = useCallback(async () => {
    const requestId = ++latestRequest.current;
    try {
      const current = await getCurrentAdmin();
      if (requestId !== latestRequest.current) return 'ok'; // a newer check or a sign-out took over
      if (!current) {
        setAdmin(null);
        setNotice('Your session has ended. Please sign in again.');
        setStatus('unauthenticated');
        return 'ended';
      }
      setAdmin(current);
      return 'ok';
    } catch (err) {
      return 'unreachable';
    }
  }, []);

  const signOut = useCallback(async () => {
    await logout(); // if this fails the error is thrown and the user stays signed in
    latestRequest.current += 1;
    setAdmin(null);
    setNotice('');
    setStatus('unauthenticated');
  }, []);

  const value = useMemo(
    () => ({ status, admin, notice, checkSession, refreshSession, signIn, signOut }),
    [status, admin, notice, checkSession, refreshSession, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return context;
}
