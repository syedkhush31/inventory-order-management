// Customer list: search, status filter, sortable columns and pagination, plus Add / Edit and Deactivate / Reactivate.
// Only one inline panel is open at a time. All data comes from the API; nothing is invented in the browser, and
// after any change the list is reloaded from the server. Customers are never deleted, only deactivated.
import { useEffect, useRef, useState } from 'react';
import { listCustomers, setCustomerActive } from '../api/customers.js';
import { ApiError, NetworkError } from '../api/client.js';
import CustomerForm from '../components/CustomerForm.jsx';
import DataTable from '../components/DataTable.jsx';
import Icon from '../components/Icon.jsx';
import Pagination from '../components/Pagination.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { formatDateTime } from '../utils/format.js';

const PAGE_SIZE = 25;

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'all', label: 'All customers' },
];

const NONE = <span className="cell--none">—</span>;

function buildColumns({ onEdit, onDeactivate, onReactivate, busyId }) {
  return [
    { key: 'name', header: 'Name', sortKey: 'name', render: (c) => c.name },
    { key: 'email', header: 'Email', sortKey: 'email', render: (c) => c.email },
    { key: 'phone', header: 'Phone', render: (c) => c.phone || NONE },
    {
      key: 'address',
      header: 'Address',
      render: (c) =>
        c.address ? (
          <span className="cell--truncate" title={c.address}>
            {c.address}
          </span>
        ) : (
          NONE
        ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (c) => <StatusBadge tone={c.isActive ? 'success' : 'neutral'}>{c.isActive ? 'Active' : 'Inactive'}</StatusBadge>,
    },
    { key: 'updated', header: 'Last updated', sortKey: 'updatedAt', render: (c) => formatDateTime(c.updatedAt) },
    {
      key: 'actions',
      header: 'Actions',
      render: (c) => (
        <span className="row-actions">
          <button
            type="button"
            className="btn btn--secondary btn--small"
            aria-label={`Edit ${c.name}`}
            onClick={() => onEdit(c)}
          >
            Edit
          </button>
          {c.isActive ? (
            <button
              type="button"
              className="btn btn--secondary btn--small"
              aria-label={`Deactivate ${c.name}`}
              disabled={busyId === c.id}
              onClick={() => onDeactivate(c)}
            >
              Deactivate
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--secondary btn--small"
              aria-label={`Reactivate ${c.name}`}
              disabled={busyId === c.id}
              onClick={() => onReactivate(c)}
            >
              {busyId === c.id ? 'Reactivating…' : 'Reactivate'}
            </button>
          )}
        </span>
      ),
    },
  ];
}

function messageForError(err) {
  if (err instanceof NetworkError) return 'Cannot reach the server. Check your connection and try again.';
  if (err instanceof ApiError && err.status === 400) {
    return 'The search options were not accepted. Clear the search and try again.';
  }
  return 'Customers could not be loaded. Please try again.';
}

function messageForActionError(err, verb) {
  if (err instanceof NetworkError) {
    return `Cannot reach the server, so the customer may not have been ${verb}d. Check the list and try again.`;
  }
  if (err instanceof ApiError && err.status === 404) return 'That customer no longer exists. The list has been refreshed.';
  return `The customer could not be ${verb}d. Please try again.`;
}

function emptyMessage(search, status) {
  if (search) return `No customers match “${search}”.`;
  if (status === 'inactive') return 'There are no inactive customers.';
  if (status === 'active') return 'There are no active customers yet. Use Add Customer to create one.';
  return 'No customers have been added yet.';
}

export default function CustomersPage({ debounceMs = 300 }) {
  const [searchText, setSearchText] = useState('');
  const search = useDebouncedValue(searchText.trim(), debounceMs);
  const [status, setStatus] = useState('active');
  const [sort, setSort] = useState({ key: 'name', order: 'asc' });

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

  // The one open inline panel: null, or { type: 'add' | 'edit' | 'deactivate', customer? }.
  const [panel, setPanel] = useState(null);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyId, setBusyId] = useState(null); // the customer whose deactivate / reactivate request is running
  const addButtonRef = useRef(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError('');

    listCustomers(
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
        : { key, order: key === 'updatedAt' ? 'desc' : 'asc' }
    );
  }

  function openPanel(next) {
    setNotice('');
    setActionError('');
    setPanel(next);
  }

  function closePanel() {
    setPanel(null);
    addButtonRef.current?.focus();
  }

  // Called only after the server confirmed a change. The list keeps its filters and sort and is reloaded.
  function finishChange(message, { firstPage = false } = {}) {
    setNotice(message);
    setPanel(null);
    if (firstPage) setPage(1);
    setReloadCount((n) => n + 1);
    addButtonRef.current?.focus();
  }

  async function changeActive(customer, makeActive) {
    if (busyId !== null) return; // one request at a time
    const verb = makeActive ? 'reactivate' : 'deactivate';
    setNotice('');
    setActionError('');
    setBusyId(customer.id);
    try {
      await setCustomerActive(customer.id, makeActive);
      finishChange(`${customer.name} was ${verb}d.`);
    } catch (err) {
      setActionError(messageForActionError(err, verb));
      if (err instanceof ApiError && err.status === 404) {
        setPanel(null);
        setReloadCount((n) => n + 1);
      }
    } finally {
      setBusyId(null);
    }
  }

  const columns = buildColumns({
    onEdit: (customer) => openPanel({ type: 'edit', customer }),
    onDeactivate: (customer) => openPanel({ type: 'deactivate', customer }),
    onReactivate: (customer) => changeActive(customer, true),
    busyId,
  });

  const hasRows = result && result.items.length > 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title" tabIndex={-1}>
            Customers
          </h1>
          <p className="page-subtitle">The people and companies you sell to.</p>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          ref={addButtonRef}
          onClick={() => openPanel({ type: 'add' })}
          aria-expanded={panel?.type === 'add'}
          aria-controls="customer-panel"
        >
          <span aria-hidden="true">+</span> Add Customer
        </button>
      </div>

      {notice ? (
        <div className="banner banner--success" role="status">
          <div className="banner__body">
            <p>{notice}</p>
          </div>
          <button type="button" className="banner__dismiss" onClick={() => setNotice('')}>
            Dismiss
          </button>
        </div>
      ) : null}

      {actionError ? (
        <div className="banner banner--error" role="alert">
          <Icon name="alert" size={16} />
          <span>{actionError}</span>
        </div>
      ) : null}

      <div id="customer-panel" className="inline-panel">
        {panel?.type === 'add' ? (
          <CustomerForm
            onCreated={(customer) => finishChange(`Customer created: ${customer.name} (${customer.email}).`, { firstPage: true })}
            onCancel={closePanel}
          />
        ) : null}
        {panel?.type === 'edit' ? (
          <CustomerForm
            key={panel.customer.id}
            customer={panel.customer}
            onSaved={(customer) => finishChange(`Customer updated: ${customer.name} (${customer.email}).`)}
            onCancel={closePanel}
          />
        ) : null}
        {panel?.type === 'deactivate' ? (
          <section className="panel product-form" aria-labelledby="deactivate-customer-heading">
            <h2 className="panel__header" id="deactivate-customer-heading">
              Deactivate {panel.customer.name}?
            </h2>
            <div className="panel__body">
              <p>
                <strong>{panel.customer.name}</strong> will be hidden from the Active list. Nothing is deleted: the customer
                and any order history are kept, and you can reactivate them at any time from the Inactive list.
              </p>
              <div className="form-actions">
                <button type="button" className="btn btn--secondary" onClick={closePanel} disabled={busyId !== null}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => changeActive(panel.customer, false)}
                  disabled={busyId !== null}
                >
                  {busyId !== null ? 'Deactivating…' : 'Deactivate customer'}
                </button>
              </div>
            </div>
          </section>
        ) : null}
      </div>

      <section className="panel" aria-label="Customer list">
        <div className="toolbar">
          <div className="toolbar__field toolbar__field--grow">
            <label className="visually-hidden" htmlFor="customer-search">
              Search customers
            </label>
            <input
              id="customer-search"
              type="search"
              className="field__input"
              placeholder="Search by name, email or phone"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              maxLength={100}
              autoComplete="off"
            />
          </div>
          <div className="toolbar__field">
            <label className="toolbar__label" htmlFor="customer-status">
              Status
            </label>
            <select
              id="customer-status"
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
            {result && !error ? `${result.total.toLocaleString('en-US')} ${result.total === 1 ? 'customer' : 'customers'}` : ''}
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
            <p>Loading customers…</p>
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
              caption="Customers"
              columns={columns}
              rows={result.items}
              rowKey={(customer) => customer.id}
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
