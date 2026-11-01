// The activity endpoint: GET /api/activity (read-only, requires a signed-in administrator).
import { apiRequest } from './client.js';

// params: { q, type, from, to, page, pageSize }
//   type: all | order | stock | product | customer | account | settings
//   from (inclusive) and to (exclusive): UTC instants such as "2026-11-01T00:00:00.000Z", both optional
// Returns { items, page, pageSize, total, totalPages }, newest first. Each item is
// { id, type, occurredAt, actor: { id, email, displayName }, entity: { type, id, label }, details }.
export function listActivity({ q, type, from, to, page, pageSize }, { signal } = {}) {
  const query = new URLSearchParams();
  if (q) query.set('q', q);
  query.set('type', type);
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  query.set('page', String(page));
  query.set('pageSize', String(pageSize));
  return apiRequest(`/api/activity?${query.toString()}`, { signal });
}
