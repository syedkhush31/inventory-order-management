// "Showing 1–25 of 60" plus Previous / Next buttons.
export default function Pagination({ page, pageSize, total, totalPages, onPageChange, disabled }) {
  if (total === 0) return null;

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav className="pagination" aria-label="Pagination">
      <p className="pagination__summary">
        Showing {first.toLocaleString('en-US')}–{last.toLocaleString('en-US')} of {total.toLocaleString('en-US')}
      </p>
      <div className="pagination__controls">
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => onPageChange(page - 1)}
          disabled={disabled || page <= 1}
        >
          Previous
        </button>
        <span className="pagination__page">
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => onPageChange(page + 1)}
          disabled={disabled || page >= totalPages}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
