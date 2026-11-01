// Settings > Security: change the password. The three password boxes are plain React state that is cleared as soon as
// the change succeeds. Nothing is written to localStorage, sessionStorage, the URL or the console, and the passwords
// are sent only in the one request. The server replaces the login cookie on success, so this browser stays signed in
// and every other session ends.
import { useEffect, useRef, useState } from 'react';
import { changePassword } from '../api/account.js';
import { UnexpectedResponseError } from '../api/products.js';
import { ApiError, NetworkError } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { MIN_NEW_PASSWORD_LENGTH, PASSWORD_FIELD_ORDER, validatePasswordForm } from '../utils/accountValidation.js';
import FormField from './FormField.jsx';
import Icon from './Icon.jsx';

const EMPTY = { currentPassword: '', newPassword: '', confirmPassword: '' };

function describeFailure(err) {
  if (err instanceof NetworkError) {
    return { formError: 'Cannot reach the server, so the password may not have been changed. Try again in a moment.' };
  }
  if (err instanceof UnexpectedResponseError) {
    return { formError: 'The server reply was not understood, so the password may or may not have been changed. If you are signed out, use the new password.' };
  }
  if (err instanceof ApiError && err.status === 403) {
    return { fieldErrors: { currentPassword: 'That is not your current password.' }, focus: 'currentPassword', clearCurrent: true };
  }
  if (err instanceof ApiError && err.status === 429) {
    return { formError: 'Too many incorrect password attempts. Please wait a few minutes and try again.', clearCurrent: true };
  }
  if (err instanceof ApiError && err.status === 400) {
    const fields = Array.isArray(err.body?.fields) ? err.body.fields : [];
    const fieldErrors = {};
    for (const field of fields) {
      if (field === 'currentPassword' || field === 'newPassword') fieldErrors[field] = 'The server did not accept this value. Please check it.';
    }
    return {
      fieldErrors,
      focus: PASSWORD_FIELD_ORDER.find((name) => fieldErrors[name]),
      formError: 'The password was not changed because some details were not accepted. Please check the form.',
    };
  }
  return { formError: 'Something went wrong and the password was not changed. Please try again.' };
}

export default function PasswordSection() {
  const { refreshSession } = useAuth();
  const [fields, setFields] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [warning, setWarning] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [focusTarget, setFocusTarget] = useState(null);
  const busy = useRef(false);
  const refs = { currentPassword: useRef(null), newPassword: useRef(null), confirmPassword: useRef(null) };

  // After a failed save the field to look at is focused once the form is enabled again (a disabled field can not take focus).
  useEffect(() => {
    if (!submitting && focusTarget) {
      refs[focusTarget].current?.focus();
      setFocusTarget(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitting, focusTarget]);

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

    const { values, errors: found } = validatePasswordForm(fields);
    setErrors(found);
    setFormError('');
    setNotice('');
    setWarning('');
    if (!values) {
      const first = PASSWORD_FIELD_ORDER.find((name) => found[name]);
      if (first) refs[first].current?.focus();
      return;
    }

    busy.current = true;
    setSubmitting(true);
    try {
      await changePassword(values);
      setFields(EMPTY); // the passwords are gone from the page the moment the change succeeds
      setErrors({});
      setNotice('Password changed. Any other devices or browsers that were signed in have been signed out.');
      // The server sent a fresh login cookie. Confirm that it works instead of assuming.
      const session = await refreshSession();
      if (session === 'unreachable') {
        setWarning('Your password was changed, but the server could not be reached to confirm your session. If pages stop loading, sign in again with the new password.');
      }
    } catch (err) {
      const failure = describeFailure(err);
      setErrors(failure.fieldErrors || {});
      setFormError(failure.formError || '');
      if (failure.clearCurrent) setFields((existing) => ({ ...existing, currentPassword: '' }));
      if (failure.focus) setFocusTarget(failure.focus);
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section className="panel product-form" aria-labelledby="security-heading">
      <h2 className="panel__header" id="security-heading">
        Security
      </h2>
      <div className="panel__body">
        <p className="product-form__note">
          Choose a new password of at least {MIN_NEW_PASSWORD_LENGTH} characters. Changing it signs out every other device and browser;
          this one stays signed in.
        </p>

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

        <form onSubmit={handleSubmit} noValidate aria-label="Change password">
          <div className="form-grid">
            <FormField
              id="security-current-password"
              label="Current password"
              requiredMark
              type="password"
              value={fields.currentPassword}
              onChange={update('currentPassword')}
              error={errors.currentPassword}
              inputRef={refs.currentPassword}
              autoComplete="current-password"
              disabled={submitting}
            />
            <div className="settings-form-spacer" aria-hidden="true" />
            <FormField
              id="security-new-password"
              label="New password"
              requiredMark
              hint={`At least ${MIN_NEW_PASSWORD_LENGTH} characters.`}
              type="password"
              value={fields.newPassword}
              onChange={update('newPassword')}
              error={errors.newPassword}
              inputRef={refs.newPassword}
              autoComplete="new-password"
              disabled={submitting}
            />
            <FormField
              id="security-confirm-password"
              label="Confirm new password"
              requiredMark
              type="password"
              value={fields.confirmPassword}
              onChange={update('confirmPassword')}
              error={errors.confirmPassword}
              inputRef={refs.confirmPassword}
              autoComplete="new-password"
              disabled={submitting}
            />
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn--primary" disabled={submitting}>
              {submitting ? 'Changing password…' : 'Change password'}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
