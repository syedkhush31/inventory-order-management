// The inline customer form. Without a `customer` it is the "Add customer" form: it sends POST /api/customers and
// reports the created customer through onCreated(customer). With a `customer` it is the "Edit customer" form:
// it is pre-filled, sends PATCH with only the fields that changed, and reports the saved customer through
// onSaved(customer). Nothing counts as saved until the server says so.
import { useEffect, useRef, useState } from 'react';
import { createCustomer, updateCustomer } from '../api/customers.js';
import { UnexpectedResponseError } from '../api/products.js';
import { ApiError, NetworkError } from '../api/client.js';
import FormField from './FormField.jsx';
import Icon from './Icon.jsx';
import { CUSTOMER_FIELD_ORDER, validateCustomerForm } from '../utils/customerValidation.js';

const EMPTY = { name: '', email: '', phone: '', address: '' };

function describeFailure(err, editing) {
  const verb = editing ? 'changes' : 'customer';

  if (err instanceof NetworkError) {
    return {
      formError: `Cannot reach the server, so the ${verb} may not have been saved. Check your connection and the customer list, then try again.`,
    };
  }

  if (err instanceof UnexpectedResponseError) {
    return {
      formError: `The server reply was not understood, so the ${verb} may or may not have been saved. Check the customer list before trying again.`,
    };
  }

  if (err instanceof ApiError && err.status === 404) {
    return { formError: 'This customer no longer exists. Close this form and check the customer list.' };
  }

  if (err instanceof ApiError && err.status === 409) {
    return {
      fieldErrors: { email: 'A customer with this email already exists. Use a different email.' },
      focus: 'email',
    };
  }

  if (err instanceof ApiError && err.status === 400) {
    const serverFields = Array.isArray(err.body?.fields) ? err.body.fields : [];
    const fieldErrors = {};
    for (const field of serverFields) {
      if (CUSTOMER_FIELD_ORDER.includes(field)) fieldErrors[field] = 'The server did not accept this value. Please check it.';
    }
    return {
      fieldErrors,
      focus: CUSTOMER_FIELD_ORDER.find((name) => fieldErrors[name]),
      formError: `The ${verb} was not saved because some details were not accepted. Please check the form.`,
    };
  }

  return { formError: `Something went wrong and the ${verb} was not saved. Please try again.` };
}

export default function CustomerForm({ customer = null, onCreated, onSaved, onCancel }) {
  const editing = customer !== null;
  const [fields, setFields] = useState(
    editing
      ? { name: customer.name, email: customer.email, phone: customer.phone ?? '', address: customer.address ?? '' }
      : EMPTY
  );
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const refs = { name: useRef(null), email: useRef(null), phone: useRef(null), address: useRef(null) };

  // Start typing straight away when the form opens.
  useEffect(() => {
    refs.name.current?.focus();
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

    const { values, errors: found } = validateCustomerForm(fields);
    setErrors(found);
    setFormError('');
    if (!values) {
      refs[CUSTOMER_FIELD_ORDER.find((name) => found[name])].current?.focus();
      return;
    }

    let changes = null;
    if (editing) {
      changes = {};
      for (const key of CUSTOMER_FIELD_ORDER) {
        if (values[key] !== customer[key]) changes[key] = values[key];
      }
      if (Object.keys(changes).length === 0) {
        setFormError('Nothing has been changed yet. Edit a field, or cancel.');
        return;
      }
    }

    setSubmitting(true);
    try {
      if (editing) {
        onSaved(await updateCustomer(customer.id, changes)); // the parent closes this form
      } else {
        onCreated(await createCustomer(values)); // the parent closes this form
      }
    } catch (err) {
      const failure = describeFailure(err, editing);
      setErrors(failure.fieldErrors || {});
      setFormError(failure.formError || '');
      setSubmitting(false);
      if (failure.focus) refs[failure.focus].current?.focus();
    }
  }

  return (
    <section className="panel product-form" aria-labelledby="customer-form-heading">
      <h2 className="panel__header" id="customer-form-heading">
        {editing ? 'Edit customer' : 'Add customer'}
      </h2>
      <form className="panel__body" onSubmit={handleSubmit} noValidate>
        <p className="product-form__note">
          Fields marked <span aria-hidden="true">*</span>
          <span className="visually-hidden">with an asterisk</span> are required.{' '}
          {editing ? 'Clear phone or address to remove it.' : 'New customers are created as active.'}
        </p>

        {formError ? (
          <div className="banner banner--error" role="alert">
            <Icon name="alert" size={16} />
            <span>{formError}</span>
          </div>
        ) : null}

        <div className="form-grid">
          <FormField
            id="customer-name"
            label="Name"
            requiredMark
            hint="Up to 255 characters."
            value={fields.name}
            onChange={update('name')}
            error={errors.name}
            inputRef={refs.name}
            autoComplete="off"
          />
          <FormField
            id="customer-email"
            label="Email"
            requiredMark
            hint="Each customer needs a different email. Saved in lower case."
            value={fields.email}
            onChange={update('email')}
            error={errors.email}
            inputRef={refs.email}
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
          />
          <FormField
            id="customer-phone"
            label="Phone"
            hint="Optional. Digits and + ( ) - . or spaces, up to 32 characters."
            value={fields.phone}
            onChange={update('phone')}
            error={errors.phone}
            inputRef={refs.phone}
            inputMode="tel"
            autoComplete="off"
          />
          <FormField
            id="customer-address"
            label="Address"
            hint="Optional. Up to 500 characters, on one line."
            value={fields.address}
            onChange={update('address')}
            error={errors.address}
            inputRef={refs.address}
            autoComplete="off"
          />
        </div>

        <div className="form-actions">
          <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting ? 'Saving…' : editing ? 'Save changes' : 'Add customer'}
          </button>
        </div>
      </form>
    </section>
  );
}
