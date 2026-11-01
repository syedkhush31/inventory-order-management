// Details of one order: customer, lines (price snapshots), total, status history and the actions that are valid for the
// current status. Every change goes through the server; nothing is assumed. If an action is saved but the order cannot
// be read back, the screen says so and hides the actions until the details are reloaded, so it is never repeated.
import { useEffect, useRef, useState } from 'react';
import { getOrder, orderAction } from '../api/orders.js';
import { UnexpectedResponseError } from '../api/products.js';
import { ApiError, NetworkError } from '../api/client.js';
import Icon from './Icon.jsx';
import StatusBadge from './StatusBadge.jsx';
import { ACTIONS_BY_STATUS, ACTION_LABELS, ACTION_PROGRESS, STATUS_TONES, statusLabel } from '../utils/orderUtils.js';
import { formatDateTime, formatPrice, formatQuantity } from '../utils/format.js';

function describeActionFailure(err, action, order) {
  const label = ACTION_LABELS[action].toLowerCase();

  if (err instanceof NetworkError) {
    return {
      message: `Cannot reach the server, so the order may not have been updated. Reload the order to check its status before trying to ${label} again.`,
      reload: true,
    };
  }
  if (err instanceof UnexpectedResponseError) {
    return {
      message: `The server reply was not understood, so the order may or may not have been updated. Reload the order to check its status before trying again.`,
      reload: true,
    };
  }
  if (err instanceof ApiError && err.status === 404) {
    return { message: 'This order no longer exists. Close this panel and check the Orders list.' };
  }
  if (err instanceof ApiError && err.status === 503) {
    return {
      message: `The server was busy, so the action was NOT completed and the order has not changed. Wait a moment, then try again.`,
    };
  }
  if (err instanceof ApiError && err.status === 409) {
    const body = err.body || {};
    if (Array.isArray(body.shortages)) {
      const names = new Map(order.items.map((item) => [item.productId, item.productName]));
      return {
        message: 'There is not enough stock to confirm this order. It is still Pending and nothing was deducted.',
        shortages: body.shortages.map((s) => ({
          name: names.get(s.productId) ?? `Product #${s.productId}`,
          requested: s.requested,
          available: s.available,
        })),
      };
    }
    if (typeof body.currentStatus === 'string') {
      return {
        message: `This action is not allowed because the order is now ${statusLabel(body.currentStatus)}. The details have been refreshed.`,
        reload: true,
      };
    }
    if (Array.isArray(body.productIds)) {
      return {
        message: 'Cancelling would put more stock back than a product can hold, so the order was not changed. Adjust that product’s stock first.',
      };
    }
  }
  return { message: `Something went wrong and the action was not completed. Reload the order to check its status.`, reload: true };
}

// onChanged(message): called after the server confirmed a change, so the list can reload. onClose(): close the panel.
export default function OrderDetail({ orderId, onChanged, onClose }) {
  const [order, setOrder] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [reloadCount, setReloadCount] = useState(0);
  const [busyAction, setBusyAction] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [failure, setFailure] = useState(null); // { message, shortages?, reload? }
  const [savedNote, setSavedNote] = useState(''); // an action succeeded but the details could not be loaded
  const headingRef = useRef(null);
  const busyRef = useRef(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoadError('');
    getOrder(orderId, { signal: controller.signal })
      .then((data) => {
        if (!active) return;
        setOrder(data);
        setSavedNote('');
      })
      .catch((err) => {
        if (!active || err.name === 'AbortError') return;
        setLoadError(
          err instanceof ApiError && err.status === 404
            ? 'This order no longer exists. Close this panel and check the Orders list.'
            : err instanceof NetworkError
              ? 'Cannot reach the server. Check your connection and try again.'
              : 'The order could not be loaded. Please try again.'
        );
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [orderId, reloadCount]);

  useEffect(() => {
    if (order) headingRef.current?.focus();
    // Move focus only when a different order has loaded, not after every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  function reload() {
    setFailure(null);
    setReloadCount((n) => n + 1);
  }

  async function runAction(action) {
    if (busyRef.current || !order) return; // one request at a time
    busyRef.current = true;
    setBusyAction(action);
    setFailure(null);
    setConfirmCancel(false);
    try {
      const result = await orderAction(order.id, action);
      if (result.partial) {
        setSavedNote(
          `Order #${result.orderId} is now ${statusLabel(result.status)}. The change was saved, but the details could not be loaded. Do not repeat the action. Reload the details to check the order.`
        );
        onChanged(`Order #${result.orderId} is now ${statusLabel(result.status)}.`);
      } else {
        setOrder(result.order);
        onChanged(`Order #${result.order.id} is now ${statusLabel(result.order.status)}.`);
      }
    } catch (err) {
      const described = describeActionFailure(err, action, order);
      setFailure(described);
      if (described.reload && err instanceof ApiError) setReloadCount((n) => n + 1);
    } finally {
      busyRef.current = false;
      setBusyAction(null);
    }
  }

  const busy = busyAction !== null;
  // Hidden while the saved state is unknown, so nobody repeats an action that already happened.
  const actions = order && !savedNote ? ACTIONS_BY_STATUS[order.status] ?? [] : [];

  return (
    <section className="panel product-form" aria-labelledby="order-detail-heading">
      <div className="panel__header panel__header--row">
        <h2 id="order-detail-heading" tabIndex={-1} ref={headingRef}>
          Order #{orderId}
        </h2>
        <button type="button" className="btn btn--secondary btn--small" onClick={onClose}>
          Close
        </button>
      </div>

      {loadError && !order ? (
        <div className="panel__state" role="alert">
          <Icon name="alert" size={24} />
          <p>{loadError}</p>
          <button type="button" className="btn btn--primary" onClick={reload}>
            Try again
          </button>
        </div>
      ) : !order ? (
        <div className="panel__state" role="status">
          <div className="spinner" aria-hidden="true" />
          <p>Loading order…</p>
        </div>
      ) : (
        <div className="panel__body">
          {savedNote ? (
            <div className="banner banner--success" role="status">
              <div className="banner__body">
                <p>{savedNote}</p>
              </div>
              <button type="button" className="banner__dismiss" onClick={reload}>
                Reload details
              </button>
            </div>
          ) : null}

          {loadError ? (
            <div className="banner banner--error" role="alert">
              <Icon name="alert" size={16} />
              <span>{loadError}</span>
            </div>
          ) : null}

          {failure ? (
            <div className="banner banner--error" role="alert">
              <Icon name="alert" size={16} />
              <div className="banner__body">
                <p>{failure.message}</p>
                {failure.shortages ? (
                  <ul className="order-shortages">
                    {failure.shortages.map((s) => (
                      <li key={s.name}>
                        {s.name}: needs {formatQuantity(s.requested)}, only {formatQuantity(s.available)} in stock
                      </li>
                    ))}
                  </ul>
                ) : null}
                {failure.reload ? (
                  <button type="button" className="btn btn--secondary btn--small" onClick={reload}>
                    Reload order
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          <dl className="order-summary">
            <div>
              <dt>Status</dt>
              <dd>
                <StatusBadge tone={STATUS_TONES[order.status] ?? 'neutral'}>{statusLabel(order.status)}</StatusBadge>
              </dd>
            </div>
            <div>
              <dt>Customer</dt>
              <dd>
                {order.customer.name}
                <span className="order-summary__sub">{order.customer.email}</span>
                {order.customer.isActive ? null : <span className="order-summary__sub">This customer is inactive.</span>}
              </dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{formatDateTime(order.createdAt)}</dd>
            </div>
            <div>
              <dt>Last updated</dt>
              <dd>{formatDateTime(order.updatedAt)}</dd>
            </div>
          </dl>

          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">Order items</caption>
              <thead>
                <tr>
                  <th scope="col">SKU</th>
                  <th scope="col">Product</th>
                  <th scope="col" className="cell--numeric">
                    Quantity
                  </th>
                  <th scope="col" className="cell--numeric">
                    Unit price
                  </th>
                  <th scope="col" className="cell--numeric">
                    Line total
                  </th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.sku}</td>
                    <td>{item.productName}</td>
                    <td className="cell--numeric">{formatQuantity(item.quantity)}</td>
                    <td className="cell--numeric">{formatPrice(item.unitPrice)}</td>
                    <td className="cell--numeric">{formatPrice(item.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={4} className="cell--numeric">
                    Order total
                  </th>
                  <td className="cell--numeric order-total">{formatPrice(order.totalAmount)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <h3 className="order-form__subheading">Status history</h3>
          {order.statusHistory.length === 0 ? (
            <p className="panel__muted">No status changes have been recorded.</p>
          ) : (
            <ol className="order-history">
              {order.statusHistory.map((entry) => (
                <li key={entry.id}>
                  <span>
                    {entry.fromStatus ? (
                      <>
                        {statusLabel(entry.fromStatus)} <span aria-hidden="true">→</span>
                        <span className="visually-hidden"> changed to </span>{' '}
                      </>
                    ) : (
                      'Created as '
                    )}
                    <strong>{statusLabel(entry.toStatus)}</strong>
                  </span>
                  <span className="order-history__time">{formatDateTime(entry.changedAt)}</span>
                </li>
              ))}
            </ol>
          )}

          {actions.length > 0 ? (
            <div className="form-actions">
              {confirmCancel ? (
                <>
                  <p className="order-confirm-text">
                    Cancel order #{order.id}?{' '}
                    {order.status === 'CONFIRMED' ? 'Its stock will be put back.' : 'No stock has been deducted yet.'} This cannot be undone.
                  </p>
                  <button type="button" className="btn btn--secondary" onClick={() => setConfirmCancel(false)} disabled={busy}>
                    Keep order
                  </button>
                  <button type="button" className="btn btn--primary" onClick={() => runAction('cancel')} disabled={busy}>
                    {busyAction === 'cancel' ? ACTION_PROGRESS.cancel : 'Yes, cancel order'}
                  </button>
                </>
              ) : (
                actions.map((action) => (
                  <button
                    key={action}
                    type="button"
                    className={action === 'cancel' ? 'btn btn--secondary' : 'btn btn--primary'}
                    disabled={busy}
                    onClick={() => (action === 'cancel' ? setConfirmCancel(true) : runAction(action))}
                  >
                    {busyAction === action ? ACTION_PROGRESS[action] : ACTION_LABELS[action]}
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
