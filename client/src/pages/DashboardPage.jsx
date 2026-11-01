// The dashboard: every figure comes from the existing list endpoints, nothing is invented or hardcoded.
// - Counts use the `total` field of a one-row page (pageSize=1), so they never depend on how many rows fit on a page.
// - Each section loads on its own. A failed request shows "Unavailable" with a retry button, never a made-up zero.
// - Low stock is computed from the active products sorted by stock, lowest first (see loadLowStock). The threshold
//   ("this many units or fewer") is the one saved in Settings: it is read from GET /api/settings every time this page
//   opens, so a change made in Settings shows here as soon as the Dashboard is opened again. It is never hardcoded.
import { useCallback, useEffect, useState } from 'react';
import { listCustomers } from '../api/customers.js';
import { listOrders } from '../api/orders.js';
import { listProducts } from '../api/products.js';
import { getSettings } from '../api/settings.js';
import Icon from '../components/Icon.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { APP_NAME } from '../config/brand.js';
import { STATUS_LABELS, STATUS_TONES } from '../utils/orderUtils.js';
import { formatDateTime, formatPrice, formatQuantity } from '../utils/format.js';

const LOW_STOCK_LOOKUP = 100; // the largest page the products endpoint allows
const LOW_STOCK_ROWS_SHOWN = 8;
const RECENT_ORDERS = 5;
const ORDER_STATUSES = Object.keys(STATUS_LABELS);

// A one-row page, used only to read `total`. The sort key must be one the endpoint accepts: orders allow 'id',
// but products and customers do not (they reject it with 400), so those two pass sort: 'name'.
const ALL = (overrides) => ({ q: '', status: 'all', page: 1, pageSize: 1, sort: 'id', order: 'asc', ...overrides });

// The total number of rows behind a list endpoint, read from its `total` field.
function totalFrom(data) {
  if (!data || !Number.isInteger(data.total) || data.total < 0) throw new Error('Unexpected response');
  return data.total;
}

function listFrom(data) {
  if (!data || !Array.isArray(data.items)) throw new Error('Unexpected response');
  return data;
}

async function loadProductCount(signal) {
  return totalFrom(await listProducts(ALL({ sort: 'name' }), { signal }));
}

async function loadCustomerCount(signal) {
  return totalFrom(await listCustomers(ALL({ sort: 'name' }), { signal }));
}

async function loadStatusCounts(signal) {
  const totals = await Promise.all(ORDER_STATUSES.map((status) => listOrders(ALL({ status }), { signal }).then(totalFrom)));
  return Object.fromEntries(ORDER_STATUSES.map((status, i) => [status, totals[i]]));
}

async function loadRecentOrders(signal) {
  const data = listFrom(
    await listOrders(ALL({ pageSize: RECENT_ORDERS, sort: 'createdAt', order: 'desc' }), { signal })
  );
  return { total: totalFrom(data), items: data.items };
}

// The saved low-stock threshold (a whole number from 0 to 1000; the server answers 5 until another value is saved).
async function loadThreshold(signal) {
  const { settings } = await getSettings({ signal });
  return settings.lowStockThreshold;
}

// The 100 active products with the least stock come back lowest first, so every product at or under the threshold
// is in that page unless all 100 are low. In that one case the exact count is unknown and `atLeast` is set.
async function loadLowStock(signal, threshold) {
  const data = listFrom(
    await listProducts(
      { q: '', status: 'active', page: 1, pageSize: LOW_STOCK_LOOKUP, sort: 'stockQuantity', order: 'asc' },
      { signal }
    )
  );
  const low = data.items.filter((product) => product.stockQuantity <= threshold);
  const allLow = low.length === data.items.length && data.total > data.items.length;
  return { items: low, count: low.length, atLeast: allLow, threshold };
}

// Runs `loader(signal)` on mount and again when retry() is called. Returns { state, data, retry }.
// A loader of null means "not ready to load yet": it stays in the loading state and sends nothing.
function useLoad(loader) {
  const [result, setResult] = useState({ state: 'loading', data: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (loader === null) {
      setResult({ state: 'loading', data: null });
      return undefined;
    }
    let active = true;
    const controller = new AbortController();
    setResult({ state: 'loading', data: null });
    loader(controller.signal)
      .then((data) => active && setResult({ state: 'ready', data }))
      .catch((err) => {
        if (active && err.name !== 'AbortError') setResult({ state: 'error', data: null });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [loader, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...result, retry };
}

function StatCard({ label, note, load, format = (value) => value.toLocaleString('en-US') }) {
  return (
    <div className="stat-card">
      <p className="stat-card__label">{label}</p>
      {load.state === 'ready' ? (
        <p className="stat-card__value">{format(load.data)}</p>
      ) : load.state === 'loading' ? (
        <p className="stat-card__value stat-card__value--muted" role="status">
          <span className="visually-hidden">Loading {label}</span>
          <span aria-hidden="true">…</span>
        </p>
      ) : (
        <>
          <p className="stat-card__value stat-card__value--muted">Unavailable</p>
          <button type="button" className="btn btn--secondary btn--small" onClick={load.retry}>
            Retry<span className="visually-hidden"> {label}</span>
          </button>
        </>
      )}
      {note ? <p className="stat-card__note">{note}</p> : null}
    </div>
  );
}

// The loading, error and empty states shared by the three panels below the cards.
function PanelState({ load, emptyText, isEmpty, errorText, children }) {
  if (load.state === 'loading') {
    return (
      <div className="panel__state" role="status">
        <div className="spinner" aria-hidden="true" />
        <p>Loading…</p>
      </div>
    );
  }
  if (load.state === 'error') {
    return (
      <div className="panel__state" role="alert">
        <Icon name="alert" size={24} />
        <p>{errorText}</p>
        <button type="button" className="btn btn--primary" onClick={load.retry}>
          Try again
        </button>
      </div>
    );
  }
  if (isEmpty(load.data)) {
    return (
      <div className="panel__state">
        <p>{emptyText}</p>
      </div>
    );
  }
  return children(load.data);
}

// onNavigate(section, search?) switches section; search is a query string such as "?order=7".
export default function DashboardPage({ onNavigate }) {
  const { admin } = useAuth();
  const products = useLoad(loadProductCount);
  const customers = useLoad(loadCustomerCount);
  const statusCounts = useLoad(loadStatusCounts);
  const recent = useLoad(loadRecentOrders);

  // Low stock needs the saved threshold first. Until it is known nothing is requested, and if it can not be loaded
  // the panel says so (with a retry) instead of quietly using a number that might be wrong.
  const threshold = useLoad(loadThreshold);
  const thresholdValue = threshold.state === 'ready' ? threshold.data : null;
  const lowStockLoader = useCallback(
    thresholdValue === null ? () => null : (signal) => loadLowStock(signal, thresholdValue),
    [thresholdValue]
  );
  const lowStockLoad = useLoad(thresholdValue === null ? null : lowStockLoader);
  const lowStock =
    threshold.state === 'error'
      ? { state: 'error', data: null, retry: threshold.retry }
      : threshold.state === 'loading'
        ? { state: 'loading', data: null, retry: threshold.retry }
        : lowStockLoad;

  // Total orders and the Pending card come from the order requests. Each can fail on its own.
  const ordersTotal = { ...recent, data: recent.data?.total };
  const pending = { ...statusCounts, data: statusCounts.data?.PENDING };

  return (
    <>
      <h1 className="page-title" tabIndex={-1}>
        Dashboard
      </h1>
      <p className="page-subtitle">
        Welcome to {APP_NAME}. Signed in as {admin.email}.
      </p>

      <section className="stat-grid" aria-label="Summary">
        <StatCard label="Total products" note="Active and inactive" load={products} />
        <StatCard label="Total customers" note="Active and inactive" load={customers} />
        <StatCard label="Total orders" note="All statuses" load={ordersTotal} />
        <StatCard label="Pending orders" note="Waiting to be confirmed" load={pending} />
      </section>

      <div className="dashboard-grid">
        <section className="panel" aria-labelledby="status-heading">
          <h2 className="panel__header" id="status-heading">
            Orders by status
          </h2>
          <PanelState
            load={statusCounts}
            isEmpty={() => false}
            errorText="Order counts could not be loaded."
          >
            {(counts) => (
              <ul className="status-list">
                {ORDER_STATUSES.map((status) => (
                  <li key={status}>
                    <StatusBadge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</StatusBadge>
                    <span className="status-list__count">{counts[status].toLocaleString('en-US')}</span>
                  </li>
                ))}
              </ul>
            )}
          </PanelState>
        </section>

        <section className="panel" aria-labelledby="low-stock-heading">
          <div className="panel__header panel__header--row">
            <h2 id="low-stock-heading">Low stock</h2>
            <button type="button" className="btn btn--secondary btn--small" onClick={() => onNavigate('inventory')}>
              Open Inventory
            </button>
          </div>
          <PanelState
            load={lowStock}
            isEmpty={(data) => data.count === 0}
            emptyText={`No active products have ${thresholdValue} or fewer in stock.`}
            errorText={
              threshold.state === 'error'
                ? 'The low-stock threshold could not be loaded, so low-stock products are not shown.'
                : 'Low-stock products could not be loaded.'
            }
          >
            {(data) => (
              <>
                <p className="panel__note">
                  Active products with {data.threshold} or fewer in stock:{' '}
                  <strong>
                    {data.count.toLocaleString('en-US')}
                    {data.atLeast ? '+' : ''}
                  </strong>
                  {data.atLeast ? ' (the exact number is not available when more than 100 products are low)' : ''}
                </p>
                <div className="table-wrap">
                  <table className="table">
                    <caption className="visually-hidden">Low-stock products</caption>
                    <thead>
                      <tr>
                        <th scope="col">Product</th>
                        <th scope="col">SKU</th>
                        <th scope="col" className="cell--numeric">
                          In stock
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.slice(0, LOW_STOCK_ROWS_SHOWN).map((product) => (
                        <tr key={product.id}>
                          <td>{product.name}</td>
                          <td>{product.sku}</td>
                          <td className="cell--numeric">
                            {product.stockQuantity === 0 ? (
                              <StatusBadge tone="danger">Out of stock</StatusBadge>
                            ) : (
                              formatQuantity(product.stockQuantity)
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {data.count > LOW_STOCK_ROWS_SHOWN ? (
                  <p className="panel__note">
                    Showing the {LOW_STOCK_ROWS_SHOWN} lowest. Open Inventory to see all products.
                  </p>
                ) : null}
              </>
            )}
          </PanelState>
        </section>
      </div>

      <section className="panel" aria-labelledby="recent-heading">
        <div className="panel__header panel__header--row">
          <h2 id="recent-heading">Recent orders</h2>
          <button type="button" className="btn btn--secondary btn--small" onClick={() => onNavigate('orders')}>
            View all orders
          </button>
        </div>
        <PanelState
          load={recent}
          isEmpty={(data) => data.items.length === 0}
          emptyText="No orders have been created yet."
          errorText="Recent orders could not be loaded."
        >
          {(data) => (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">Most recent orders</caption>
                <thead>
                  <tr>
                    <th scope="col">Order</th>
                    <th scope="col">Customer</th>
                    <th scope="col">Date</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="cell--numeric">
                      Total
                    </th>
                    <th scope="col">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((order) => (
                    <tr key={order.id}>
                      <td>#{order.id}</td>
                      <td>{order.customer.name}</td>
                      <td>{formatDateTime(order.createdAt)}</td>
                      <td>
                        <StatusBadge tone={STATUS_TONES[order.status] ?? 'neutral'}>
                          {STATUS_LABELS[order.status] ?? order.status}
                        </StatusBadge>
                      </td>
                      <td className="cell--numeric">{formatPrice(order.totalAmount)}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--secondary btn--small"
                          aria-label={`View order #${order.id}`}
                          onClick={() => onNavigate('orders', `?order=${order.id}`)}
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </PanelState>
      </section>
    </>
  );
}
