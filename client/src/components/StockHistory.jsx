// The inline "Stock history" panel for one product: a read-only, paginated table of its stock corrections,
// newest first. Data comes from GET /api/products/:id/stock-adjustments; nothing is calculated in the browser.
import { useEffect, useState } from 'react';
import { listStockAdjustments } from '../api/products.js';
import { ApiError, NetworkError } from '../api/client.js';
import DataTable from './DataTable.jsx';
import Icon from './Icon.jsx';
import Pagination from './Pagination.jsx';
import { formatDateTime, formatQuantity } from '../utils/format.js';

const PAGE_SIZE = 10;

// The table is not sortable (always newest first), so it has no sort state.
const NO_SORT = { key: '', order: 'desc' };

const COLUMNS = [
  { key: 'when', header: 'Date and time', render: (a) => formatDateTime(a.createdAt) },
  {
    key: 'change',
    header: 'Change',
    numeric: true,
    render: (a) => (
      <span className={a.quantityDelta > 0 ? 'history-change history-change--up' : 'history-change history-change--down'}>
        {a.quantityDelta > 0 ? '+' : '-'}
        {formatQuantity(Math.abs(a.quantityDelta))}
      </span>
    ),
  },
  { key: 'reason', header: 'Reason', render: (a) => a.reason },
  { key: 'admin', header: 'Administrator ID', numeric: true, render: (a) => a.adminId },
];

function messageForError(err) {
  if (err instanceof NetworkError) return 'Cannot reach the server. Check your connection and try again.';
  if (err instanceof ApiError && err.status === 404) return 'This product no longer exists. Close this panel and refresh the list.';
  return 'The stock history could not be loaded. Please try again.';
}

export default function StockHistory({ product, onClose }) {
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null); // the last successful response
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError('');

    listStockAdjustments(product.id, { page, pageSize: PAGE_SIZE }, { signal: controller.signal })
      .then((data) => {
        if (!active) return;
        if (!data || !Array.isArray(data.items)) {
          // A "200 OK" without the expected list must not leave the panel loading forever.
          setResult(null);
          setError(messageForError(null));
        } else {
          setResult(data);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (!active || err.name === 'AbortError') return;
        setResult(null);
        setError(messageForError(err));
        setLoading(false);
      });

    // An older answer must never replace a newer one.
    return () => {
      active = false;
      controller.abort();
    };
  }, [product.id, page, reloadCount]);

  // If the page no longer exists, fall back to the last real one.
  useEffect(() => {
    if (result && !loading && result.items.length === 0 && result.total > 0 && page > result.totalPages) {
      setPage(result.totalPages);
    }
  });

  return (
    <section className="panel product-form" aria-labelledby="stock-history-heading">
      <h2 className="panel__header" id="stock-history-heading">
        Stock history: {product.sku}
      </h2>
      <div className="panel__body">
        <p className="product-form__note">
          {product.name} — every stock correction, newest first. This list is read-only.
        </p>

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
            <p>Loading stock history…</p>
          </div>
        ) : result.total === 0 ? (
          <div className="panel__state">
            <p>No stock corrections have been recorded for this product yet.</p>
          </div>
        ) : (
          <>
            <DataTable
              caption={`Stock history for ${product.sku}`}
              columns={COLUMNS}
              rows={result.items}
              rowKey={(adjustment) => adjustment.id}
              sort={NO_SORT}
              onSort={() => {}}
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

        <div className="form-actions">
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </section>
  );
}
