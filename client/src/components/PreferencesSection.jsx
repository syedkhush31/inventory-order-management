// Settings > Inventory preferences: the low-stock threshold. A product counts as "low stock" on the Dashboard when it has
// this many units or fewer. Whole numbers from 0 to 1000; the server uses 5 until a different value has been saved.
// The Dashboard reads the saved value from the server each time it opens, so a change here shows there straight away.
import { useEffect, useRef, useState } from 'react';
import { updateSettings } from '../api/settings.js';
import { UnexpectedResponseError } from '../api/products.js';
import { ApiError, NetworkError } from '../api/client.js';
import {
  DEFAULT_LOW_STOCK_THRESHOLD,
  MAX_LOW_STOCK_THRESHOLD,
  MIN_LOW_STOCK_THRESHOLD,
  validateThreshold,
} from '../utils/accountValidation.js';
import FormField from './FormField.jsx';
import Icon from './Icon.jsx';

function describeFailure(err) {
  if (err instanceof NetworkError) {
    return { formError: 'Cannot reach the server, so the threshold may not have been saved. Check your connection and try again.' };
  }
  if (err instanceof UnexpectedResponseError) {
    return { formError: 'The server reply was not understood, so the threshold may or may not have been saved. Reload the page to check.' };
  }
  if (err instanceof ApiError && err.status === 400) {
    return { fieldError: `The server did not accept this value. Use a whole number from ${MIN_LOW_STOCK_THRESHOLD} to ${MAX_LOW_STOCK_THRESHOLD}.` };
  }
  return { formError: 'Something went wrong and the threshold was not saved. Please try again.' };
}

// settings: { lowStockThreshold } from the server. onSaved(settings) is called with the saved settings.
export default function PreferencesSection({ settings, onSaved }) {
  const saved = settings.lowStockThreshold;
  const [text, setText] = useState(String(saved));
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [refocus, setRefocus] = useState(false);
  const busy = useRef(false);
  const inputRef = useRef(null);

  // After a failed save the field is focused once the form is enabled again (a disabled field can not take focus).
  useEffect(() => {
    if (!submitting && refocus) {
      inputRef.current?.focus();
      setRefocus(false);
    }
  }, [submitting, refocus]);

  const unchanged = text.trim() === String(saved);

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy.current) return; // a second click or Enter press while saving does nothing

    const { value, error: found } = validateThreshold(text);
    setError(found);
    setFormError('');
    setNotice('');
    if (found) {
      inputRef.current?.focus();
      return;
    }
    if (value === saved) {
      setNotice(`The low-stock threshold is already ${saved}.`);
      return;
    }

    busy.current = true;
    setSubmitting(true);
    try {
      const next = await updateSettings({ lowStockThreshold: value });
      onSaved(next);
      setText(String(next.lowStockThreshold)); // show exactly what the server saved, in the same step as the message
      setNotice(`Low-stock threshold saved: ${next.lowStockThreshold}.`);
    } catch (err) {
      const failure = describeFailure(err);
      setError(failure.fieldError || '');
      setFormError(failure.formError || '');
      if (failure.fieldError) setRefocus(true);
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section className="panel product-form" aria-labelledby="preferences-heading">
      <h2 className="panel__header" id="preferences-heading">
        Inventory preferences
      </h2>
      <div className="panel__body">
        <p className="product-form__note">
          Active products with this many units in stock or fewer are listed as low stock on the Dashboard. The standard value is{' '}
          {DEFAULT_LOW_STOCK_THRESHOLD}.
        </p>

        {notice ? (
          <div className="banner banner--success" role="status">
            <div className="banner__body">
              <p>{notice}</p>
            </div>
          </div>
        ) : null}
        {formError ? (
          <div className="banner banner--error" role="alert">
            <Icon name="alert" size={16} />
            <span>{formError}</span>
          </div>
        ) : null}

        <form onSubmit={handleSubmit} noValidate aria-label="Inventory preferences">
          <div className="form-grid">
            <FormField
              id="preferences-threshold"
              label="Low-stock threshold"
              requiredMark
              hint={`A whole number from ${MIN_LOW_STOCK_THRESHOLD} to ${MAX_LOW_STOCK_THRESHOLD}. With 0, only products that are out of stock count as low.`}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setError('');
                setNotice('');
              }}
              error={error}
              inputRef={inputRef}
              inputMode="numeric"
              autoComplete="off"
              disabled={submitting}
            />
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn--primary" disabled={submitting || unchanged}>
              {submitting ? 'Saving…' : 'Save threshold'}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
