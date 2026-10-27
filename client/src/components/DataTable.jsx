// A reusable table. Column headers with a sortKey are buttons that call onSort(sortKey).
// columns: [{ key, header, sortKey?, numeric?, render(row) }]
export default function DataTable({ caption, columns, rows, rowKey, sort, onSort, busy }) {
  return (
    <div className="table-wrap" aria-busy={busy ? 'true' : 'false'}>
      <table className={`table table--data${busy ? ' table--busy' : ''}`}>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const sorted = column.sortKey && sort.key === column.sortKey;
              const ariaSort = sorted ? (sort.order === 'asc' ? 'ascending' : 'descending') : undefined;
              return (
                <th
                  key={column.key}
                  scope="col"
                  className={column.numeric ? 'cell--numeric' : undefined}
                  aria-sort={column.sortKey ? ariaSort || 'none' : undefined}
                >
                  {column.sortKey ? (
                    <button type="button" className="sort-button" onClick={() => onSort(column.sortKey)}>
                      {column.header}
                      <span className="sort-button__arrow" aria-hidden="true">
                        {sorted ? (sort.order === 'asc' ? '▲' : '▼') : ''}
                      </span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.key} className={column.numeric ? 'cell--numeric' : undefined}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
