// Order list: search, status filter, sortable columns and pagination, plus Create order and order details.
// Only one inline panel is open at a time. All data comes from the API; after any change the list is reloaded from
// the server. Orders are never deleted: they move through statuses, and Cancelled is the end of the line.
import { useEffect, useRef, useState } from 'react';
import { listOrders } from '../api/orders.js';
import { ApiError, NetworkError } from '../api/client.js';
import DataTable from '../components/DataTable.jsx';
import Icon from '../components/Icon.jsx';
import OrderDetail from '../components/OrderDetail.jsx';
import OrderForm from '../components/OrderForm.jsx';
import Pagination from '../components/Pagination.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { STATUS_LABELS, STATUS_TONES, statusLabel } from '../utils/orderUtils.js';
import { formatDateTime, formatPrice } from '../utils/format.js';

const PAGE_SIZE = 25;

const STATUS_OPTIONS = [
  { value: 'all', label: 'All orders' },
  ...Object.keys(STATUS_LABELS).map((value) => ({ value, label: STATUS_LABELS[value] })),
];

function buildColumns({ onView, selectedId }) {
  return [
    { key: 'id', header: 'Order', sortKey: 'id', render: (o) => `#${o.id}` },
    {
      key: 'customer',
      header: 'Customer',
      sortKey: 'customerName',
      render: (o) => (
        <>
          {o.customer.name}
          <span className="cell__sub">{o.customer.email}</span>
        </>
      ),
    },
    { key: 'date', header: 'Date', sortKey: 'createdAt', render: (o) => formatDateTime(o.createdAt) },
    { key: 'items', header: 'Items', numeric: true, render: (o) => o.itemCount },
    { key: 'total', header: 'Total', sortKey: 'totalAmount', numeric: true, render: (o) => formatPrice(o.totalAmount) },
    {
      key: 'status',
      header: 'Status',
      sortKey: 'status',
      render: (o) => <StatusBadge tone={STATUS_TONES[o.status] ?? 'neutral'}>{statusLabel(o.status)}</StatusBadge>,
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (o) => (
        <button
          type="button"
          className="btn btn--secondary btn--small"
          aria-label={`View order #${o.id}`}
          aria-expanded={selectedId === o.id}
          onClick={() => onView(o)}
        >
          View
        </button>
      ),
    },
  ];
}

function messageForError(err) {
  if (err instanceof NetworkError) return 'Cannot reach the server. Check your connection and try again.';
  if (err instanceof ApiError && err.status === 400) {
    return 'The search options were not accepted. Clear the search and try again.';
  }
  return 'Orders could not be loaded. Please try again.';
}

function emptyMessage(search, status) {
  if (search) return `No orders match “${search}”.`;
  if (status !== 'all') return `There are no ${statusLabel(status).toLowerCase()} orders.`;
  return 'No orders have been created yet. Use Create Order to add the first one.';
}

export default function OrdersPage({ debounceMs = 300 }) {
  const [searchText, setSearchText] = useState('');
  const search = useDebouncedValue(searchText.trim(), debounceMs);
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState({ key: 'createdAt', order: 'desc' });

  // The page number belongs to the current filters. When any filter changes the stored page no longer
  // matches, so we fall back to page 1 without needing an extra request.
  const filterKey = `${search}|${status}|${sort.key}|${sort.order}`;
  const [pageState, setPageState] = useState({ key: filterKey, page: 1 });
  const page = pageState.key === filterKey ? pageState.page : 1;
  const setPage = (next) => setPageState({ key: filterKey, page: next });

  const [result, setResult] = useState(null); // the last successful response
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadCount, setReloadCount] = useState(0);

  // The one open inline panel: null, { type: 'create' } or { type: 'detail', id }.
  // A link such as /orders?order=7 (from the dashboard) opens that order's details straight away.
  const [panel, setPanel] = useState(() => {
    const id = new URLSearchParams(window.location.search).get('order');
    return id && /^[1-9]\d{0,14}$/.test(id) ? { type: 'detail', id: Number(id) } : null;
  });
  const [notice, setNotice] = useState(null); // { message, tone }
  const createButtonRef = useRef(null);

  // The link has done its job; drop the query so a later refresh does not reopen the panel.
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError('');

    listOrders(
      { q: search, status, page, pageSize: PAGE_SIZE, sort: sort.key, order: sort.order },
      { signal: controller.signal }
    )
      .then((data) => {
        if (!active) return;
        if (!data || !Array.isArray(data.items)) {
          // A "200 OK" without the expected list must not leave the page loading forever.
          setResult(null);
          setError(messageForError(null));
          setLoading(false);
          return;
        }
        setResult(data);
        setLoading(false);
      })
      .catch((err) => {
        if (!active || err.name === 'AbortError') return;
        setResult(null);
        setError(messageForError(err));
        setLoading(false);
      });

    // Runs when the filters change or the page closes: an older answer must never replace a newer one.
    return () => {
      active = false;
      controller.abort();
    };
  }, [search, status, page, sort.key, sort.order, reloadCount]);

  // If the current page no longer exists (fewer results than before), jump to the last real page.
  useEffect(() => {
    if (result && !loading && result.items.length === 0 && result.total > 0 && page > result.totalPages) {
      setPage(result.totalPages);
    }
  });

  function handleSort(key) {
    setSort((current) =>
      current.key === key
        ? { key, order: current.order === 'asc' ? 'desc' : 'asc' }
        : { key, order: key === 'id' || key === 'createdAt' || key === 'totalAmount' ? 'desc' : 'asc' }
    );
  }

  function openPanel(next) {
    setNotice(null);
    setPanel(next);
  }

  function closePanel() {
    setPanel(null);
    createButtonRef.current?.focus();
  }

  // Called after the server accepted a new order. A partial success (saved, details not loaded) is still a success:
  // the message says the order exists and never suggests creating it again.
  function handleCreated(created) {
    setPanel(null);
    setNotice(
      created.partial
        ? {
            tone: 'success',
            message: `Order #${created.orderId} was created (${statusLabel(created.status)}, total ${formatPrice(created.totalAmount)}), but its details could not be loaded. It is saved: do not create it again. Find it in the list below.`,
          }
        : {
            tone: 'success',
            message: `Order #${created.order.id} was created for ${created.order.customer.name} (total ${formatPrice(created.order.totalAmount)}).`,
          }
    );
    // Newest first, so the new order is at the top of the first page.
    setSearchText('');
    setStatus('all');
    setSort({ key: 'createdAt', order: 'desc' });
    setPage(1);
    setReloadCount((n) => n + 1);
    createButtonRef.current?.focus();
  }

  // The detail panel stays open after an action, so only the list is refreshed and a short notice is shown.
  function handleChanged(message) {
    setNotice({ tone: 'success', message });
    setReloadCount((n) => n + 1);
  }

  const selectedId = panel?.type === 'detail' ? panel.id : null;
  const columns = buildColumns({ onView: (order) => openPanel({ type: 'detail', id: order.id }), selectedId });
  const hasRows = result && result.items.length > 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title" tabIndex={-1}>
            Orders
          </h1>
          <p className="page-subtitle">Create orders and follow them from Pending to Delivered.</p>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          ref={createButtonRef}
          onClick={() => openPanel({ type: 'create' })}
          aria-expanded={panel?.type === 'create'}
          aria-controls="order-panel"
        >
          <span aria-hidden="true">+</span> Create Order
        </button>
      </div>

      {notice ? (
        <div className="banner banner--success" role="status">
          <div className="banner__body">
            <p>{notice.message}</p>
          </div>
          <button type="button" className="banner__dismiss" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div id="order-panel" className="inline-panel">
        {panel?.type === 'create' ? <OrderForm onCreated={handleCreated} onCancel={closePanel} /> : null}
        {panel?.type === 'detail' ? (
          <OrderDetail key={panel.id} orderId={panel.id} onChanged={handleChanged} onClose={closePanel} />
        ) : null}
      </div>

      <section className="panel" aria-label="Order list">
        <div className="toolbar">
          <div className="toolbar__field toolbar__field--grow">
            <label className="visually-hidden" htmlFor="order-search">
              Search orders
            </label>
            <input
              id="order-search"
              type="search"
              className="field__input"
              placeholder="Search by order number, customer name or email"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              maxLength={100}
              autoComplete="off"
            />
          </div>
          <div className="toolbar__field">
            <label className="toolbar__label" htmlFor="order-status">
              Status
            </label>
            <select
              id="order-status"
              className="field__input"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <p className="toolbar__count" role="status">
            {result && !error ? `${result.total.toLocaleString('en-US')} ${result.total === 1 ? 'order' : 'orders'}` : ''}
          </p>
        </div>

        {error ? (
          <div className="panel__state" role="alert">
            <Icon name="alert" size={24} />
            <p>{error}</p>
            <button type="button" className="btn btn--primary" onClick={() => setReloadCount((n) => n + 1)}>
              Try again
            </button>
          </div>
        ) : !result ? (
          <div className="panel__state" role="status">
            <div className="spinner" aria-hidden="true" />
            <p>Loading orders…</p>
          </div>
        ) : !hasRows && result.total === 0 ? (
          <div className="panel__state">
            <p>{emptyMessage(search, status)}</p>
            {search ? (
              <button type="button" className="btn btn--secondary" onClick={() => setSearchText('')}>
                Clear search
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <DataTable
              caption="Orders"
              columns={columns}
              rows={result.items}
              rowKey={(order) => order.id}
              sort={sort}
              onSort={handleSort}
              busy={loading}
            />
            <Pagination
              page={result.page}
              pageSize={result.pageSize}
              total={result.total}
              totalPages={result.totalPages}
              onPageChange={setPage}
              disabled={loading}
            />
          </>
        )}
      </section>
    </>
  );
}
