import { useRef, useState } from 'react';
import FormField from '../components/FormField.jsx';
import Icon from '../components/Icon.jsx';
import ShelfIllustration from '../components/ShelfIllustration.jsx';
import { ApiError, NetworkError } from '../api/client.js';
import { SessionVerificationError, useAuth } from '../auth/AuthContext.jsx';
import { APP_NAME, APP_TAGLINE } from '../config/brand.js';

// Turns a technical error into one short message. The 401 message is deliberately generic:
// it never says whether the email or the password was wrong.
function messageForError(err) {
  if (err instanceof NetworkError) {
    return 'Cannot reach the server. Check your connection and try again.';
  }
  if (err instanceof SessionVerificationError) {
    return 'You were signed in, but the session could not be verified. Make sure cookies are enabled and try again.';
  }
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Invalid email or password.';
    if (err.status === 400) return 'Please check the email address and password and try again.';
    if (err.status === 429) return 'Too many sign-in attempts. Please wait a few minutes and try again.';
    if (err.status === 403) return 'The sign-in request was blocked. Reload the page and try again.';
  }
  return 'Something went wrong. Please try again.';
}

export default function LoginPage() {
  const { signIn, notice } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const emailRef = useRef(null);
  const passwordRef = useRef(null);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const errors = {};
    if (email.trim() === '') errors.email = 'Enter your email address.';
    if (password === '') errors.password = 'Enter your password.';
    setFieldErrors(errors);
    setFormError('');
    if (errors.email) {
      emailRef.current?.focus();
      return;
    }
    if (errors.password) {
      passwordRef.current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
      // On success the app switches to the dashboard, so nothing else to do here.
    } catch (err) {
      setFormError(messageForError(err));
      setPassword(''); // never keep a rejected password in the form
      setSubmitting(false);
      passwordRef.current?.focus();
    }
  }

  return (
    <div className="login">
      <div className="login__brand">
        <div className="login__brand-lockup">
          <span className="login__brand-mark">
            <Icon name="inventory" size={22} />
          </span>
          <span className="login__brand-name">{APP_NAME}</span>
        </div>

        <div className="login__brand-body">
          <p className="login__brand-tagline">{APP_TAGLINE}</p>
          <p className="login__brand-description">
            Product catalogue and stock control for warehouse supervisors, inventory controllers and order-processing
            teams.
          </p>
        </div>

        <ShelfIllustration />
      </div>

      <main className="login__main">
        <div className="login__panel">
          <h1 className="login__title">Administrator sign in</h1>
          <p className="login__subtitle">Sign in to continue to {APP_NAME}.</p>

          <form className="login__form" onSubmit={handleSubmit} noValidate>
            {notice ? (
              <div className="banner banner--info" role="status">
                <span>{notice}</span>
              </div>
            ) : null}
            {formError ? (
              <div className="banner banner--error" role="alert">
                <Icon name="alert" size={16} />
                <span>{formError}</span>
              </div>
            ) : null}

            <FormField
              id="email"
              label="Email address"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              error={fieldErrors.email}
              inputRef={emailRef}
              required
            />
            <FormField
              id="password"
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              error={fieldErrors.password}
              inputRef={passwordRef}
              required
            />

            <button type="submit" className="btn btn--primary" disabled={submitting}>
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="login__footer">Access is limited to authorised administrators.</p>
        </div>
      </main>
    </div>
  );
}
