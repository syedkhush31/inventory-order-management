// Activity: a read-only history of what administrators did, newest first, built from the records the server stores:
// order status changes, manual stock corrections, and product / customer / account / settings changes since the audit
// log was introduced. Nothing is invented in the browser, and nothing before each record type began is shown.
// Search, the type filter and the date range are all applied by the server; changing any of them returns to page 1.
import { useEffect, useMemo, useState } from 'react';
import { listActivity } from '../api/activity.js';
import { ApiError, NetworkError } from '../api/client.js';
import ActivityDetails from '../components/ActivityDetails.jsx';
import ActivityRowBoundary from '../components/ActivityRowBoundary.jsx';
import Icon from '../components/Icon.jsx';
import Pagination from '../components/Pagination.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';
import { TYPE_OPTIONS, actorName, dateRangeToInstants, dayHeading, eventInfo, groupByDay, summarise, timeOfDay } from '../utils/activityUtils.js';
import { formatDateTime } from '../utils/format.js';

const PAGE_SIZE = 25;

function messageForError(err) {
  if (err instanceof NetworkError) return 'Cannot reach the server. Check your connection and try again.';
  if (err instanceof ApiError && err.status === 400) return 'The filters were not accepted. Clear them and try again.';
  return 'Activity could not be loaded. Please try again.';
}

function emptyMessage({ search, type, hasDates }) {
  if (search || hasDates || type !== 'all') return 'No recorded activity matches these filters.';
  return 'No activity has been recorded yet.';
}

// Anything in the list that is not an object (a null from a broken reply) is skipped instead of crashing the page.
const isEventObject = (item) => item !== null && typeof item === 'object' && !Array.isArray(item);

// One event: the dot, the badge and summary, who and when, and its details. It sits inside ActivityRowBoundary, so a
// malformed event can only ever replace this one row. Missing pieces are tolerated: see summarise() and actorName().
function ActivityRow({ event, open, onToggle, onNavigate }) {
  const info = eventInfo(event.type);
  const label = event.entity && typeof event.entity.label === 'string' ? event.entity.label : 'event';
  return (
    <>
      <span className={`activity-item__dot activity-item__dot--${info.tone}`} aria-hidden="true" />
      <div className="activity-item__main">
        <div className="activity-item__top">
          <StatusBadge tone={info.tone}>{info.title}</StatusBadge>
          <span className="activity-item__summary">{summarise(event)}</span>
        </div>
        <p className="activity-item__meta">
          <time dateTime={event.occurredAt} title={formatDateTime(event.occurredAt)}>
            {timeOfDay(event.occurredAt)}
          </time>
          <span aria-hidden="true"> · </span>
          by {actorName(event.actor)}
        </p>
        {open ? <ActivityDetails event={event} onNavigate={onNavigate} /> : null}
      </div>
      <button
        type="button"
        className="btn btn--secondary btn--small activity-item__toggle"
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Show'} details: ${info.title}, ${label}`}
        onClick={onToggle}
      >
        {open ? 'Hide' : 'Details'}
      </button>
    </>
  );
}

// onNavigate(section, search?) switches section (used by the "Open order" style buttons in the details).
export default function ActivityPage({ debounceMs = 300, onNavigate = () => {} }) {
  const [searchText, setSearchText] = useState('');
  const search = useDebouncedValue(searchText.trim(), debounceMs);
  const [type, setType] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const range = useMemo(() => dateRangeToInstants(fromDate, toDate), [fromDate, toDate]);
  const rangeError = range.error || '';
  const { from, to } = range;

  // The page number belongs to the current filters. When any filter changes the stored page no longer matches, so we
  // fall back to page 1 without needing an extra request.
  const filterKey = `${search}|${type}|${from ?? ''}|${to ?? ''}`;
  const [pageState, setPageState] = useState({ key: filterKey, page: 1 });
  const page = pageState.key === filterKey ? pageState.page : 1;
  const setPage = (next) => setPageState({ key: filterKey, page: next });

  const [result, setResult] = useState(null); // the last successful response
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadCount, setReloadCount] = useState(0);
  const [openId, setOpenId] = useState(null); // the one event whose details are open

  useEffect(() => {
    if (rangeError) {
      // An impossible date range is explained next to the date fields; no request is made for it.
      setLoading(false);
      return undefined;
    }
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError('');

    listActivity({ q: search, type, from, to, page, pageSize: PAGE_SIZE }, { signal: controller.signal })
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
        setOpenId(null);
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
  }, [search, type, from, to, page, rangeError, reloadCount]);

  // If the current page no longer exists (fewer results than before), jump to the last real page.
  useEffect(() => {
    if (result && !loading && result.items.length === 0 && result.total > 0 && page > result.totalPages) {
      setPage(result.totalPages);
    }
  });

  const hasDates = Boolean(fromDate || toDate);
  const filtered = Boolean(search || type !== 'all' || hasDates);
  const groups = useMemo(() => (result ? groupByDay(result.items.filter(isEventObject)) : []), [result]);

  function clearFilters() {
    setSearchText('');
    setType('all');
    setFromDate('');
    setToDate('');
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title" tabIndex={-1}>
            Activity
          </h1>
          <p className="page-subtitle">Who did what, and when. Newest first.</p>
        </div>
      </div>

      <section className="panel" aria-label="Activity history">
        <div className="toolbar activity-toolbar">
          <div className="toolbar__field toolbar__field--grow">
            <label className="visually-hidden" htmlFor="activity-search">
              Search activity
            </label>
            <input
              id="activity-search"
              type="search"
              className="field__input"
              placeholder="Search order number, customer, SKU or administrator"
              aria-describedby="activity-search-hint"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              maxLength={100}
              autoComplete="off"
            />
          </div>
          <div className="toolbar__field">
            <label className="toolbar__label" htmlFor="activity-type">
              Type
            </label>
            <select id="activity-type" className="field__input" value={type} onChange={(event) => setType(event.target.value)}>
              {TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="toolbar__field">
            <label className="toolbar__label" htmlFor="activity-from">
              From
            </label>
            <input
              id="activity-from"
              type="date"
              className="field__input"
              value={fromDate}
              max={toDate || undefined}
              onChange={(event) => setFromDate(event.target.value)}
              aria-invalid={rangeError ? 'true' : 'false'}
              aria-describedby={rangeError ? 'activity-range-error' : undefined}
            />
          </div>
          <div className="toolbar__field">
            <label className="toolbar__label" htmlFor="activity-to">
              To
            </label>
            <input
              id="activity-to"
              type="date"
              className="field__input"
              value={toDate}
              min={fromDate || undefined}
              onChange={(event) => setToDate(event.target.value)}
              aria-invalid={rangeError ? 'true' : 'false'}
              aria-describedby={rangeError ? 'activity-range-error' : undefined}
            />
          </div>
          {filtered ? (
            <button type="button" className="btn btn--secondary" onClick={clearFilters}>
              Clear filters
            </button>
          ) : null}
          <p className="toolbar__count" role="status">
            {result && !error && !rangeError ? `${result.total.toLocaleString('en-US')} ${result.total === 1 ? 'event' : 'events'}` : ''}
          </p>
        </div>

        <p id="activity-search-hint" className="activity-search-hint">
          Matches order number (12 or #12), customer name, product SKU or name, and administrator. Orders are not searched by the
          products they contain.
        </p>

        {rangeError ? (
          <p id="activity-range-error" className="field__error activity-range-error" role="alert">
            {rangeError}
          </p>
        ) : null}

        {rangeError ? null : error ? (
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
            <p>Loading activity…</p>
          </div>
        ) : result.total === 0 ? (
          <div className="panel__state">
            <Icon name="activity" size={24} />
            <p>{emptyMessage({ search, type, hasDates })}</p>
            {filtered ? (
              <button type="button" className="btn btn--secondary" onClick={clearFilters}>
                Clear filters
              </button>
            ) : null}
          </div>
        ) : (
          <div aria-busy={loading ? 'true' : 'false'} className={loading ? 'activity-busy' : undefined}>
            {groups.map((group) => (
              <section key={group.key} className="activity-day" aria-label={dayHeading(group.date)}>
                <h2 className="activity-day__heading">{dayHeading(group.date)}</h2>
                <ol className="activity-list">
                  {group.events.map((event, index) => {
                    // An event without a usable id still gets a row of its own that opens and closes on its own.
                    const rowId = typeof event.id === 'string' && event.id ? event.id : `${group.key}#${index}`;
                    return (
                      <li key={rowId} className="activity-item">
                        <ActivityRowBoundary event={event}>
                          <ActivityRow
                            event={event}
                            open={openId === rowId}
                            onToggle={() => setOpenId(openId === rowId ? null : rowId)}
                            onNavigate={onNavigate}
                          />
                        </ActivityRowBoundary>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
            <Pagination
              page={result.page}
              pageSize={result.pageSize}
              total={result.total}
              totalPages={result.totalPages}
              onPageChange={setPage}
              disabled={loading}
            />
          </div>
        )}
      </section>

      <p className="activity-note">
        The history shows what is recorded. Orders and manual stock changes are shown from the start; product, customer, profile and
        settings changes are shown from when the activity log was introduced. Earlier changes of those kinds are not available.
      </p>
    </>
  );
}
