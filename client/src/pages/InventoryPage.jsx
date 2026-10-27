// Read-only product list: search, status filter, sortable columns and pagination.
// All data comes from GET /api/products. Nothing is calculated or invented in the browser.
import { useEffect, useRef, useState } from 'react';
import { listProducts } from '../api/products.js';
import { ApiError, NetworkError } from '../api/client.js';
import DataTable from '../components/DataTable.jsx';
import Icon from '../components/Icon.jsx';
import Pagination from '../components/Pagination.jsx';
import ProductForm from '../components/ProductForm.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { formatDateTime, formatPrice, formatQuantity } from '../utils/format.js';

const PAGE_SIZE = 25;

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'all', label: 'All products' },
];

const COLUMNS = [
  { key: 'sku', header: 'SKU', sortKey: 'sku', render: (p) => p.sku },
  { key: 'name', header: 'Product name', sortKey: 'name', render: (p) => p.name },
  { key: 'price', header: 'Price', sortKey: 'price', numeric: true, render: (p) => formatPrice(p.price) },
  {
    key: 'stock',
    header: 'Stock on hand',
    sortKey: 'stockQuantity',
    numeric: true,
    render: (p) => (
      <span className="stock-cell">
        {p.stockQuantity === 0 ? <StatusBadge tone="danger">Out of stock</StatusBadge> : null}
        <span>{formatQuantity(p.stockQuantity)}</span>
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (p) => <StatusBadge tone={p.isActive ? 'success' : 'neutral'}>{p.isActive ? 'Active' : 'Inactive'}</StatusBadge>,
  },
  { key: 'updated', header: 'Last updated', sortKey: 'updatedAt', render: (p) => formatDateTime(p.updatedAt) },
];

function messageForError(err) {
  if (err instanceof NetworkError) return 'Cannot reach the server. Check your connection and try again.';
  if (err instanceof ApiError && err.status === 400) {
    return 'The search options were not accepted. Clear the search and try again.';
  }
  return 'Products could not be loaded. Please try again.';
}

function emptyMessage(search, status) {
  if (search) return `No products match “${search}”.`;
  if (status === 'inactive') return 'There are no inactive products.';
  if (status === 'active') return 'There are no active products.';
  return 'No products have been added yet.';
}

export default function InventoryPage({ debounceMs = 300 }) {
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

  // Add product: whether the inline form is open, and the confirmation shown after a successful save.
  const [showForm, setShowForm] = useState(false);
  const [created, setCreated] = useState(null);
  const addButtonRef = useRef(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError('');

    listProducts(
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

  function openForm() {
    setCreated(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    addButtonRef.current?.focus();
  }

  // Called only after the server confirmed the save. Filters and sort stay as they are; we go back to page 1.
  function handleCreated(product) {
    setCreated(product);
    setShowForm(false);
    setPage(1);
    setReloadCount((n) => n + 1);
    addButtonRef.current?.focus();
  }

  const hasRows = result && result.items.length > 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title" tabIndex={-1}>
            Inventory
          </h1>
          <p className="page-subtitle">Products and current stock on hand.</p>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          ref={addButtonRef}
          onClick={openForm}
          aria-expanded={showForm}
          aria-controls="add-product-panel"
        >
          <span aria-hidden="true">+</span> Add Product
        </button>
      </div>

      {created ? (
        <div className="banner banner--success" role="status">
          <div className="banner__body">
            <p>
              Product created: <strong>{created.sku}</strong> — {created.name}.
            </p>
            <p className="banner__detail">
              The list was reloaded from page 1 and still uses your current search, status filter and sort, so the new
              product may be on another page or hidden by a filter.
            </p>
          </div>
          <button type="button" className="banner__dismiss" onClick={() => setCreated(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div id="add-product-panel">
        {showForm ? <ProductForm onCreated={handleCreated} onCancel={closeForm} /> : null}
      </div>

      <section className="panel" aria-label="Product list">
        <div className="toolbar">
          <div className="toolbar__field toolbar__field--grow">
            <label className="visually-hidden" htmlFor="product-search">
              Search products
            </label>
            <input
              id="product-search"
              type="search"
              className="field__input"
              placeholder="Search by SKU or product name"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              maxLength={100}
              autoComplete="off"
            />
          </div>
          <div className="toolbar__field">
            <label className="toolbar__label" htmlFor="product-status">
              Status
            </label>
            <select
              id="product-status"
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
            {result && !error ? `${result.total.toLocaleString('en-US')} ${result.total === 1 ? 'product' : 'products'}` : ''}
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
            <p>Loading products…</p>
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
              caption="Products"
              columns={COLUMNS}
              rows={result.items}
              rowKey={(product) => product.id}
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
