// Settings > Profile: shows who is signed in and lets them change their display name and their email address.
// Changing the email needs the current password (the field appears only while the email is being changed). Nothing
// counts as saved until the server says so.
import { useLayoutEffect, useRef, useState } from 'react';
import { updateProfile } from '../api/account.js';
import { UnexpectedResponseError } from '../api/products.js';
import { ApiError, NetworkError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { PROFILE_FIELD_ORDER, validateProfileForm } from '../utils/accountValidation.js';
import { formatDateTime } from '../utils/format.js';
import FormField from './FormField.jsx';
import Icon from './Icon.jsx';

function describeFailure(err) {
  if (err instanceof NetworkError) {
    return { formError: 'Cannot reach the server, so your changes may not have been saved. Check your connection and try again.' };
  }
  if (err instanceof UnexpectedResponseError) {
    return { formError: 'The server reply was not understood, so your changes may or may not have been saved. Reload the page to check.' };
  }
  if (err instanceof ApiError && err.status === 403) {
    return { fieldErrors: { currentPassword: 'That is not your current password.' }, focus: 'currentPassword', clearPassword: true };
  }
  if (err instanceof ApiError && err.status === 409) {
    return { fieldErrors: { email: 'Another account already uses this email address. Use a different one.' }, focus: 'email' };
  }
  if (err instanceof ApiError && err.status === 429) {
    return { formError: 'Too many incorrect password attempts. Please wait a few minutes and try again.', clearPassword: true };
  }
  if (err instanceof ApiError && err.status === 400) {
    const fields = Array.isArray(err.body?.fields) ? err.body.fields : [];
    const fieldErrors = {};
    for (const field of fields) {
      if (PROFILE_FIELD_ORDER.includes(field)) fieldErrors[field] = 'The server did not accept this value. Please check it.';
    }
    return {
      fieldErrors,
      focus: PROFILE_FIELD_ORDER.find((name) => fieldErrors[name]),
      formError: 'Your changes were not saved because some details were not accepted. Please check the form.',
    };
  }
  return { formError: 'Something went wrong and your changes were not saved. Please try again.' };
}

// account: { id, email, displayName, createdAt } from the server. onSaved(account) is called with the saved account.
export default function ProfileSection({ account, onSaved }) {
  const { refreshSession } = useAuth();
  const [fields, setFields] = useState({ displayName: account.displayName ?? '', email: account.email, currentPassword: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [warning, setWarning] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [focusTarget, setFocusTarget] = useState(null);
  const busy = useRef(false);
  const refs = { displayName: useRef(null), email: useRef(null), currentPassword: useRef(null) };

  // After a failed save the field to look at is focused once the form is enabled again (a disabled field can not take focus).
  // A layout effect, not a normal one: it runs in the same step as the DOM update that shows the error message, so the
  // error and the focus always appear together. A normal effect runs a moment later, which left a gap in which the
  // message was on screen but the focus had not moved yet.
  useLayoutEffect(() => {
    if (!submitting && focusTarget) {
      refs[focusTarget].current?.focus();
      setFocusTarget(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitting, focusTarget]);

  const current = { displayName: account.displayName, email: account.email };
  const emailChanging = fields.email.trim().toLowerCase() !== account.email;

  function update(name) {
    return (event) => {
      const value = event.target.value;
      setFields((existing) => ({ ...existing, [name]: value }));
      setErrors((existing) => (existing[name] ? { ...existing, [name]: undefined } : existing));
      setNotice('');
    };
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy.current) return; // a second click or Enter press while saving does nothing

    const { values, errors: found } = validateProfileForm(fields, current);
    setErrors(found);
    setFormError(found.form || '');
    setNotice('');
    setWarning('');
    if (!values) {
      const first = PROFILE_FIELD_ORDER.find((name) => found[name]);
      if (first) refs[first].current?.focus();
      return;
    }

    busy.current = true;
    setSubmitting(true);
    try {
      const saved = await updateProfile(values);
      onSaved(saved);
      // Show exactly what the server saved (trimmed, lower-cased) and drop the password, in the same step as the message.
      setFields({ displayName: saved.displayName ?? '', email: saved.email, currentPassword: '' });
      setNotice(values.email ? 'Profile saved. Your email address has been changed.' : 'Profile saved.');
      // The top bar shows the signed-in email: ask the server who is signed in now.
      const session = await refreshSession();
      if (session === 'unreachable') {
        setWarning('Your changes were saved, but your session details could not be refreshed. Reload the page if the top bar looks out of date.');
      }
    } catch (err) {
      const failure = describeFailure(err);
      setErrors(failure.fieldErrors || {});
      setFormError(failure.formError || '');
      if (failure.clearPassword) setFields((existing) => ({ ...existing, currentPassword: '' }));
      if (failure.focus) setFocusTarget(failure.focus);
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section className="panel product-form" aria-labelledby="profile-heading">
      <h2 className="panel__header" id="profile-heading">
        Profile
      </h2>
      <div className="panel__body">
        <dl className="settings-summary">
          <div>
            <dt>Signed in as</dt>
            <dd>{account.email}</dd>
          </div>
          <div>
            <dt>Display name</dt>
            <dd>{account.displayName ?? <span className="cell--none">Not set</span>}</dd>
          </div>
          <div>
            <dt>Account created</dt>
            <dd>{formatDateTime(account.createdAt) || '—'}</dd>
          </div>
        </dl>

        {notice ? (
          <div className="banner banner--success" role="status">
            <div className="banner__body">
              <p>{notice}</p>
            </div>
          </div>
        ) : null}
        {warning ? (
          <div className="banner banner--info" role="status">
            <Icon name="alert" size={16} />
            <span>{warning}</span>
          </div>
        ) : null}
        {formError ? (
          <div className="banner banner--error" role="alert">
            <Icon name="alert" size={16} />
            <span>{formError}</span>
          </div>
        ) : null}

        <form onSubmit={handleSubmit} noValidate aria-label="Edit profile">
          <div className="form-grid">
            <FormField
              id="profile-display-name"
              label="Display name"
              hint="Optional. Shown instead of your email where a name is shown. Up to 100 characters."
              value={fields.displayName}
              onChange={update('displayName')}
              error={errors.displayName}
              inputRef={refs.displayName}
              autoComplete="name"
              disabled={submitting}
            />
            <FormField
              id="profile-email"
              label="Email address"
              hint="You sign in with this address. Changing it needs your current password."
              value={fields.email}
              onChange={update('email')}
              error={errors.email}
              inputRef={refs.email}
              inputMode="email"
              autoComplete="email"
              spellCheck={false}
              disabled={submitting}
            />
            {emailChanging ? (
              <FormField
                id="profile-current-password"
                label="Current password"
                requiredMark
                hint="Required because you are changing your email address."
                type="password"
                value={fields.currentPassword}
                onChange={update('currentPassword')}
                error={errors.currentPassword}
                inputRef={refs.currentPassword}
                autoComplete="current-password"
                disabled={submitting}
              />
            ) : null}
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn--primary" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save profile'}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
