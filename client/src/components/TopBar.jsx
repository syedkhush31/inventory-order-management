import { useState } from 'react';
import Icon from './Icon.jsx';
import { useAuth } from '../auth/AuthContext.jsx';

// Shows who is signed in and the Sign out button.
export default function TopBar() {
  const { admin, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSignOut() {
    setBusy(true);
    setError('');
    try {
      await signOut(); // on success the app switches to the login page
    } catch (err) {
      // Stay on the dashboard: the server may not have ended the session, so do not pretend it did.
      setError('Sign out failed. Check your connection and try again.');
      setBusy(false);
    }
  }

  return (
    <header className="topbar">
      {error ? (
        <div className="banner banner--error topbar__error" role="alert">
          <Icon name="alert" size={16} />
          <span>{error}</span>
        </div>
      ) : null}
      <span className="topbar__user">
        Signed in as <strong>{admin.email}</strong>
      </span>
      <button type="button" className="btn btn--secondary" onClick={handleSignOut} disabled={busy}>
        <Icon name="logout" size={16} />
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </header>
  );
}
