// The inline "Adjust stock" form for one product. The administrator types a signed change (5 adds five, -3 removes
// three) and a reason; the form shows the stock that would result and refuses a change that would go below 0.
// It sends POST /api/products/:id/stock-adjustments and reports the result through onAdjusted({ product, adjustment }).
// The server checks again against the real stock, so a change made elsewhere in the meantime is still caught.
import { useEffect, useRef, useState } from 'react';
import { adjustStock, UnexpectedResponseError } from '../api/products.js';
import { ApiError, NetworkError } from '../api/client.js';
import FormField from './FormField.jsx';
import Icon from './Icon.jsx';
import { previewStock, STOCK_FIELD_ORDER, validateStockAdjustment } from '../utils/productValidation.js';
import { formatQuantity } from '../utils/format.js';

function describeFailure(err) {
  if (err instanceof NetworkError) {
    return {
      formError:
        'Cannot reach the server, so the correction may not have been saved. Check your connection and the product list, then try again.',
    };
  }

  if (err instanceof UnexpectedResponseError) {
    return {
      formError:
        'The server reply was not understood, so the correction may or may not have been saved. Check the product list before trying again.',
    };
  }

  if (err instanceof ApiError && err.status === 404) {
    return { formError: 'This product no longer exists. Close this form and check the product list.' };
  }

  if (err instanceof ApiError && err.status === 409) {
    const current = err.body?.currentStock;
    const known = Number.isInteger(current) ? ` There are ${formatQuantity(current)} on hand right now.` : '';
    return {
      fieldErrors: { delta: `This correction could not be applied.${known} Check the list and try again.` },
      focus: 'delta',
    };
  }

  if (err instanceof ApiError && err.status === 400) {
    const serverFields = Array.isArray(err.body?.fields) ? err.body.fields : [];
    const fieldErrors = {};
    for (const field of serverFields) {
      if (field === 'delta' || field === 'reason') fieldErrors[field] = 'The server did not accept this value. Please check it.';
    }
    return {
      fieldErrors,
      focus: STOCK_FIELD_ORDER.find((name) => fieldErrors[name]),
      formError: 'The correction was not saved because some details were not accepted. Please check the form.',
    };
  }

  return { formError: 'Something went wrong and the correction was not saved. Please try again.' };
}

export default function StockAdjustForm({ product, onAdjusted, onCancel }) {
  const [fields, setFields] = useState({ delta: '', reason: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const refs = { delta: useRef(null), reason: useRef(null) };

  useEffect(() => {
    refs.delta.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(name) {
    return (event) => {
      const value = event.target.value;
      setFields((current) => ({ ...current, [name]: value }));
      setErrors((current) => (current[name] ? { ...current, [name]: undefined } : current));
    };
  }

  const after = previewStock(fields.delta, product.stockQuantity);
  const wouldBeNegative = after !== null && after < 0;

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return; // a second click or Enter press while saving does nothing

    const { values, errors: found } = validateStockAdjustment(fields, product.stockQuantity);
    setErrors(found);
    setFormError('');
    if (!values) {
      refs[STOCK_FIELD_ORDER.find((name) => found[name])].current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      onAdjusted(await adjustStock(product.id, values)); // the parent closes this form
    } catch (err) {
      const failure = describeFailure(err);
      setErrors(failure.fieldErrors || {});
      setFormError(failure.formError || '');
      setSubmitting(false);
      if (failure.focus) refs[failure.focus].current?.focus();
    }
  }

  return (
    <section className="panel product-form" aria-labelledby="adjust-stock-heading">
      <h2 className="panel__header" id="adjust-stock-heading">
        Adjust stock: {product.sku}
      </h2>
      <form className="panel__body" onSubmit={handleSubmit} noValidate>
        <p className="product-form__note">
          {product.name} — <strong>{formatQuantity(product.stockQuantity)}</strong> on hand now. Every correction is saved
          in the stock history with your reason.
          {product.isActive ? '' : ' This product is inactive; its stock can still be corrected.'}
        </p>

        {formError ? (
          <div className="banner banner--error" role="alert">
            <Icon name="alert" size={16} />
            <span>{formError}</span>
          </div>
        ) : null}

        <div className="form-grid">
          <FormField
            id="stock-delta"
            label="Change in stock"
            requiredMark
            hint="A whole number. Use a minus sign to remove stock, for example -3. Use 5 or +5 to add."
            value={fields.delta}
            onChange={update('delta')}
            error={errors.delta}
            inputRef={refs.delta}
            inputMode="numeric"
            autoComplete="off"
          />
          <FormField
            id="stock-reason"
            label="Reason"
            requiredMark
            hint="For example: recount, damaged, found on shelf. Up to 255 characters."
            value={fields.reason}
            onChange={update('reason')}
            error={errors.reason}
            inputRef={refs.reason}
            autoComplete="off"
          />
        </div>

        <p className={`stock-preview${wouldBeNegative ? ' stock-preview--bad' : ''}`} role="status">
          {after === null
            ? 'Type a change to see the new stock.'
            : wouldBeNegative
              ? `This would leave ${formatQuantity(after)}. Stock cannot go below 0.`
              : `Stock after this change: ${formatQuantity(after)}`}
        </p>

        <div className="form-actions">
          <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save correction'}
          </button>
        </div>
      </form>
    </section>
  );
}
