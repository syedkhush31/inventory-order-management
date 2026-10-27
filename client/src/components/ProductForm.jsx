// The inline "Add product" form. It checks the input, sends POST /api/products, and reports the
// created product to its parent through onCreated(product). Nothing counts as saved until the server says so.
import { useEffect, useRef, useState } from 'react';
import { createProduct, UnexpectedResponseError } from '../api/products.js';
import { ApiError, NetworkError } from '../api/client.js';
import FormField from './FormField.jsx';
import Icon from './Icon.jsx';
import { FIELD_ORDER, validateProductForm } from '../utils/productValidation.js';

const EMPTY = { sku: '', name: '', price: '', stock: '' };

// The server names fields as the API does; the form uses its own names.
const SERVER_FIELD_TO_FORM_FIELD = { sku: 'sku', name: 'name', price: 'price', stockQuantity: 'stock' };

function describeFailure(err) {
  if (err instanceof NetworkError) {
    return {
      formError:
        'Cannot reach the server, so the product may not have been saved. Check your connection and the product list, then try again.',
    };
  }

  if (err instanceof UnexpectedResponseError) {
    return {
      formError:
        'The server reply was not understood, so the product may or may not have been saved. Check the product list before trying again.',
    };
  }

  if (err instanceof ApiError && err.status === 409) {
    return {
      fieldErrors: { sku: 'A product with this SKU already exists. Choose a different SKU.' },
      focus: 'sku',
    };
  }

  if (err instanceof ApiError && err.status === 400) {
    const serverFields = Array.isArray(err.body?.fields) ? err.body.fields : [];
    const fieldErrors = {};
    for (const field of serverFields) {
      const formField = SERVER_FIELD_TO_FORM_FIELD[field];
      if (formField) fieldErrors[formField] = 'The server did not accept this value. Please check it.';
    }
    const first = FIELD_ORDER.find((name) => fieldErrors[name]);
    return {
      fieldErrors,
      focus: first,
      formError: 'The product was not saved because some details were not accepted. Please check the form.',
    };
  }

  return { formError: 'Something went wrong and the product was not saved. Please try again.' };
}

export default function ProductForm({ onCreated, onCancel }) {
  const [fields, setFields] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const refs = { sku: useRef(null), name: useRef(null), price: useRef(null), stock: useRef(null) };

  // Start typing straight away when the form opens.
  useEffect(() => {
    refs.sku.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(name) {
    return (event) => {
      const value = event.target.value;
      setFields((current) => ({ ...current, [name]: value }));
      setErrors((current) => (current[name] ? { ...current, [name]: undefined } : current));
    };
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return; // a second click or Enter press while saving does nothing

    const { values, errors: found } = validateProductForm(fields);
    setErrors(found);
    setFormError('');
    if (!values) {
      refs[FIELD_ORDER.find((name) => found[name])].current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      const product = await createProduct(values);
      onCreated(product); // the parent closes this form
    } catch (err) {
      const failure = describeFailure(err);
      setErrors(failure.fieldErrors || {});
      setFormError(failure.formError || '');
      setSubmitting(false);
      if (failure.focus) refs[failure.focus].current?.focus();
    }
  }

  return (
    <section className="panel product-form" aria-labelledby="add-product-heading">
      <h2 className="panel__header" id="add-product-heading">
        Add product
      </h2>
      <form className="panel__body" onSubmit={handleSubmit} noValidate>
        <p className="product-form__note">
          Fields marked <span aria-hidden="true">*</span>
          <span className="visually-hidden">with an asterisk</span> are required. New products are created as active.
        </p>

        {formError ? (
          <div className="banner banner--error" role="alert">
            <Icon name="alert" size={16} />
            <span>{formError}</span>
          </div>
        ) : null}

        <div className="form-grid">
          <FormField
            id="product-sku"
            label="SKU"
            requiredMark
            hint="Letters, digits and - _ . / only, no spaces. Up to 64 characters."
            value={fields.sku}
            onChange={update('sku')}
            error={errors.sku}
            inputRef={refs.sku}
            autoComplete="off"
            spellCheck={false}
          />
          <FormField
            id="product-name"
            label="Product name"
            requiredMark
            hint="Up to 255 characters."
            value={fields.name}
            onChange={update('name')}
            error={errors.name}
            inputRef={refs.name}
            autoComplete="off"
          />
          <FormField
            id="product-price"
            label="Price"
            requiredMark
            hint="For example 19.99. Up to 8 digits and 2 decimals, no currency symbol."
            value={fields.price}
            onChange={update('price')}
            error={errors.price}
            inputRef={refs.price}
            inputMode="decimal"
            autoComplete="off"
          />
          <FormField
            id="product-stock"
            label="Initial stock quantity"
            hint="Whole number. Leave blank for 0."
            value={fields.stock}
            onChange={update('stock')}
            error={errors.stock}
            inputRef={refs.stock}
            inputMode="numeric"
            autoComplete="off"
          />
        </div>

        <div className="form-actions">
          <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting ? 'Saving…' : 'Add product'}
          </button>
        </div>
      </form>
    </section>
  );
}
