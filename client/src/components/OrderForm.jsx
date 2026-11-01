// The inline "Create order" form. It loads active customers and active products, lets the administrator build one or
// more product lines, and sends POST /api/orders. The total shown is an estimate from the prices loaded here: the
// server picks the real prices, adds up the real total and sets the status. Nothing counts as created until the
// server says so, and a created order is never sent twice.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createOrder } from '../api/orders.js';
import { listCustomers } from '../api/customers.js';
import { listProducts, UnexpectedResponseError } from '../api/products.js';
import { ApiError, NetworkError } from '../api/client.js';
import Icon from './Icon.jsx';
import {
  MAX_ITEMS_PER_ORDER,
  MAX_QUANTITY_PER_ITEM,
  centsToPrice,
  estimateLineCents,
  parseQuantity,
  validateOrder,
} from '../utils/orderUtils.js';
import { formatPrice, formatQuantity } from '../utils/format.js';

const LOOKUP_PAGE_SIZE = 100; // the largest page the server allows

function describeFailure(err) {
  if (err instanceof NetworkError) {
    return {
      formError:
        'Cannot reach the server, so the order may or may not have been created. Check the Orders list before trying again.',
    };
  }
  if (err instanceof UnexpectedResponseError) {
    return {
      formError:
        'The server reply was not understood, so the order may or may not have been created. Check the Orders list before trying again.',
    };
  }
  if (err instanceof ApiError && err.status === 409) {
    const body = err.body || {};
    if (Array.isArray(body.fields) && body.fields.includes('customerId')) {
      return { customerError: 'This customer is inactive. Choose an active customer.', formError: 'The order was not created.' };
    }
    if (Array.isArray(body.productIds)) {
      return {
        productIds: body.productIds.map(String),
        formError: 'The order was not created because some products are inactive. Remove them or choose other products.',
      };
    }
  }
  if (err instanceof ApiError && err.status === 400) {
    const fields = Array.isArray(err.body?.fields) ? err.body.fields : [];
    if (fields.includes('customerId') && err.body?.error === 'Customer not found') {
      return { customerError: 'This customer no longer exists. Choose another.', formError: 'The order was not created.' };
    }
    if (Array.isArray(err.body?.productIds)) {
      return {
        productIds: err.body.productIds.map(String),
        formError: 'The order was not created because some products no longer exist. Remove them and try again.',
      };
    }
    if (err.body?.error === 'The order total is too large') {
      return { formError: 'The order total is too large. Reduce the quantities and try again.' };
    }
    return { formError: 'The order was not created because some details were not accepted. Please check the form.' };
  }
  if (err instanceof ApiError && err.status === 503) {
    return { formError: 'The server was busy and the order was not created. Wait a moment and try again.' };
  }
  return { formError: 'Something went wrong and the order was not created. Please try again.' };
}

// onCreated(result): result is the object from createOrder() (a full order, or a saved order without details).
export default function OrderForm({ onCreated, onCancel }) {
  const [lookups, setLookups] = useState({ state: 'loading', customers: [], products: [], truncated: false });
  const [reloadCount, setReloadCount] = useState(0);
  const [customerId, setCustomerId] = useState('');
  const nextKey = useRef(2);
  const [lines, setLines] = useState([{ key: 1, productId: '', quantity: '1' }]);
  const [errors, setErrors] = useState({ lines: {} });
  const [serverProductIds, setServerProductIds] = useState([]);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const customerRef = useRef(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLookups((current) => ({ ...current, state: 'loading' }));
    Promise.all([
      listCustomers(
        { q: '', status: 'active', page: 1, pageSize: LOOKUP_PAGE_SIZE, sort: 'name', order: 'asc' },
        { signal: controller.signal }
      ),
      listProducts(
        { q: '', status: 'active', page: 1, pageSize: LOOKUP_PAGE_SIZE, sort: 'name', order: 'asc' },
        { signal: controller.signal }
      ),
    ])
      .then(([customers, products]) => {
        if (!active) return;
        if (!customers || !Array.isArray(customers.items) || !products || !Array.isArray(products.items)) {
          setLookups({ state: 'error', customers: [], products: [], truncated: false });
          return;
        }
        setLookups({
          state: 'ready',
          customers: customers.items,
          products: products.items,
          truncated: customers.total > customers.items.length || products.total > products.items.length,
        });
      })
      .catch((err) => {
        if (!active || err.name === 'AbortError') return;
        setLookups({ state: 'error', customers: [], products: [], truncated: false });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [reloadCount]);

  useEffect(() => {
    if (lookups.state === 'ready') customerRef.current?.focus();
  }, [lookups.state]);

  const productsById = useMemo(() => new Map(lookups.products.map((p) => [String(p.id), p])), [lookups.products]);

  const estimate = useMemo(() => {
    let cents = 0;
    let complete = lines.length > 0;
    for (const line of lines) {
      const lineCents = estimateLineCents(productsById.get(line.productId), line.quantity);
      if (lineCents === null) complete = false;
      else cents += lineCents;
    }
    return { cents, complete };
  }, [lines, productsById]);

  function updateLine(key, changes) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...changes } : line)));
    setErrors((current) => (current.lines[key] ? { ...current, lines: { ...current.lines, [key]: undefined } } : current));
    setServerProductIds([]);
  }

  function stepQuantity(line, delta) {
    const current = parseQuantity(line.quantity) ?? 0;
    const next = Math.min(MAX_QUANTITY_PER_ITEM, Math.max(1, current + delta));
    updateLine(line.key, { quantity: String(next) });
  }

  function addLine() {
    if (lines.length >= MAX_ITEMS_PER_ORDER) return;
    setLines((current) => [...current, { key: nextKey.current++, productId: '', quantity: '1' }]);
  }

  function removeLine(key) {
    setLines((current) => current.filter((line) => line.key !== key));
    setServerProductIds([]);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return; // a second click or Enter press while saving does nothing

    const { values, errors: found } = validateOrder({ customerId, lines });
    setErrors(found);
    setFormError('');
    setServerProductIds([]);
    if (!values) {
      if (found.customer) customerRef.current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      onCreated(await createOrder(values)); // the parent closes this form
    } catch (err) {
      const failure = describeFailure(err);
      setFormError(failure.formError || '');
      setErrors({ customer: failure.customerError, lines: {} });
      setServerProductIds(failure.productIds || []);
      setSubmitting(false);
      if (failure.customerError) customerRef.current?.focus();
    }
  }

  const ready = lookups.state === 'ready';

  return (
    <section className="panel product-form" aria-labelledby="order-form-heading">
      <h2 className="panel__header" id="order-form-heading">
        Create order
      </h2>

      {lookups.state === 'loading' ? (
        <div className="panel__state" role="status">
          <div className="spinner" aria-hidden="true" />
          <p>Loading customers and products…</p>
        </div>
      ) : lookups.state === 'error' ? (
        <div className="panel__state" role="alert">
          <Icon name="alert" size={24} />
          <p>Customers and products could not be loaded, so an order cannot be created right now.</p>
          <div className="form-actions form-actions--plain">
            <button type="button" className="btn btn--secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" onClick={() => setReloadCount((n) => n + 1)}>
              Try again
            </button>
          </div>
        </div>
      ) : (
        <form className="panel__body" onSubmit={handleSubmit} noValidate>
          <p className="product-form__note">
            New orders start as Pending. Stock is checked and deducted when the order is confirmed, and the server sets the
            final prices and total.
          </p>

          {lookups.truncated ? (
            <div className="banner banner--info" role="status">
              <Icon name="alert" size={16} />
              <span>Only the first {LOOKUP_PAGE_SIZE} active customers and products (A–Z) are listed here.</span>
            </div>
          ) : null}

          {formError ? (
            <div className="banner banner--error" role="alert">
              <Icon name="alert" size={16} />
              <span>{formError}</span>
            </div>
          ) : null}

          <div className="field order-form__customer">
            <label className="field__label" htmlFor="order-customer">
              Customer
              <span className="field__required" aria-hidden="true">
                {' '}
                *
              </span>
            </label>
            <select
              id="order-customer"
              ref={customerRef}
              className="field__input"
              value={customerId}
              onChange={(event) => {
                setCustomerId(event.target.value);
                setErrors((current) => ({ ...current, customer: undefined }));
              }}
              aria-invalid={errors.customer ? 'true' : 'false'}
              aria-describedby={errors.customer ? 'order-customer-error' : undefined}
              aria-required="true"
              disabled={submitting}
            >
              <option value="">{lookups.customers.length === 0 ? 'No active customers' : 'Select a customer'}</option>
              {lookups.customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name} ({customer.email})
                </option>
              ))}
            </select>
            {errors.customer ? (
              <p id="order-customer-error" className="field__error">
                {errors.customer}
              </p>
            ) : null}
          </div>

          <h3 className="order-form__subheading">Products</h3>
          {errors.form ? (
            <p className="field__error" role="alert">
              {errors.form}
            </p>
          ) : null}

          <ul className="order-lines">
            {lines.map((line, index) => {
              const product = productsById.get(line.productId);
              const lineErrors = errors.lines[line.key] || {};
              const productError =
                lineErrors.product ||
                (serverProductIds.includes(line.productId) ? 'The server rejected this product. Remove or replace it.' : '');
              const lineCents = estimateLineCents(product, line.quantity);
              const quantity = parseQuantity(line.quantity);
              const overStock = product && quantity !== null && quantity > product.stockQuantity;
              const n = index + 1;
              return (
                <li className="order-line" key={line.key}>
                  <div className="field order-line__product">
                    <label className="field__label" htmlFor={`order-product-${line.key}`}>
                      Product {n}
                    </label>
                    <select
                      id={`order-product-${line.key}`}
                      className="field__input"
                      value={line.productId}
                      onChange={(event) => updateLine(line.key, { productId: event.target.value })}
                      aria-invalid={productError ? 'true' : 'false'}
                      aria-describedby={productError ? `order-product-${line.key}-error` : undefined}
                      disabled={submitting}
                    >
                      <option value="">{lookups.products.length === 0 ? 'No active products' : 'Select a product'}</option>
                      {lookups.products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.sku} — {p.name} ({formatPrice(p.price)})
                        </option>
                      ))}
                    </select>
                    {productError ? (
                      <p id={`order-product-${line.key}-error`} className="field__error">
                        {productError}
                      </p>
                    ) : product ? (
                      <p className={`field__hint${overStock ? ' field__hint--warn' : ''}`}>
                        {overStock
                          ? `Only ${formatQuantity(product.stockQuantity)} in stock now. The order can still be created, but it cannot be confirmed until stock is available.`
                          : `${formatQuantity(product.stockQuantity)} in stock.`}
                      </p>
                    ) : null}
                  </div>

                  <div className="field order-line__quantity">
                    <label className="field__label" htmlFor={`order-qty-${line.key}`}>
                      Quantity<span className="visually-hidden"> for product {n}</span>
                    </label>
                    <div className="stepper">
                      <button
                        type="button"
                        className="btn btn--secondary stepper__button"
                        aria-label={`Decrease quantity for product ${n}`}
                        onClick={() => stepQuantity(line, -1)}
                        disabled={submitting || (quantity !== null && quantity <= 1)}
                      >
                        −
                      </button>
                      <input
                        id={`order-qty-${line.key}`}
                        className="field__input stepper__input"
                        inputMode="numeric"
                        autoComplete="off"
                        value={line.quantity}
                        onChange={(event) => updateLine(line.key, { quantity: event.target.value })}
                        aria-invalid={lineErrors.quantity ? 'true' : 'false'}
                        aria-describedby={lineErrors.quantity ? `order-qty-${line.key}-error` : undefined}
                        disabled={submitting}
                      />
                      <button
                        type="button"
                        className="btn btn--secondary stepper__button"
                        aria-label={`Increase quantity for product ${n}`}
                        onClick={() => stepQuantity(line, 1)}
                        disabled={submitting || (quantity !== null && quantity >= MAX_QUANTITY_PER_ITEM)}
                      >
                        +
                      </button>
                    </div>
                    {lineErrors.quantity ? (
                      <p id={`order-qty-${line.key}-error`} className="field__error">
                        {lineErrors.quantity}
                      </p>
                    ) : null}
                  </div>

                  <div className="order-line__total">
                    <span className="field__label">Line estimate</span>
                    <span className="order-line__amount">{lineCents === null ? '—' : formatPrice(centsToPrice(lineCents))}</span>
                  </div>

                  <button
                    type="button"
                    className="btn btn--secondary btn--small order-line__remove"
                    aria-label={`Remove product ${n}`}
                    onClick={() => removeLine(line.key)}
                    disabled={submitting || lines.length === 1}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>

          <button
            type="button"
            className="btn btn--secondary"
            onClick={addLine}
            disabled={submitting || lines.length >= MAX_ITEMS_PER_ORDER}
          >
            <span aria-hidden="true">+</span> Add another product
          </button>

          <p className="order-form__estimate" aria-live="polite">
            Estimated total: <strong>{estimate.complete ? formatPrice(centsToPrice(estimate.cents)) : '—'}</strong>
            <span className="order-form__estimate-note"> Estimate only. The server sets the final prices and total.</span>
          </p>

          <div className="form-actions">
            <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="btn btn--primary" disabled={submitting || !ready}>
              {submitting ? 'Creating order…' : 'Create order'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
