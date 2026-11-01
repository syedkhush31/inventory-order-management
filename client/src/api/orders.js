// The order endpoints under /api/orders (all require a signed-in administrator).
import { apiRequest } from './client.js';
import { UnexpectedResponseError } from './products.js';

export const ORDER_ACTIONS = ['confirm', 'cancel', 'ship', 'deliver'];

// params: { q, status, page, pageSize, sort, order }
// Returns { items, page, pageSize, total, totalPages }. Each item is
// { id, status, totalAmount, itemCount, customer: { id, name, email }, createdAt, updatedAt }.
export function listOrders({ q, status, page, pageSize, sort, order }, { signal } = {}) {
  const query = new URLSearchParams();
  if (q) query.set('q', q);
  query.set('status', status);
  query.set('page', String(page));
  query.set('pageSize', String(pageSize));
  query.set('sort', sort);
  query.set('order', order);
  return apiRequest(`/api/orders?${query.toString()}`, { signal });
}

// GET /api/orders/:id  ->  { order } with customer, items (price snapshots) and statusHistory. 404 if unknown.
export async function getOrder(id, { signal } = {}) {
  const data = await apiRequest(`/api/orders/${encodeURIComponent(id)}`, { signal });
  if (!data || !data.order) {
    throw new UnexpectedResponseError();
  }
  return data.order;
}

// The server saved the change but could not read the order back: { order: null, orderId, status, detailsAvailable: false }.
// That is a success. Callers must treat it as saved and never repeat the request.
function isSavedWithoutDetails(data) {
  return Boolean(data) && data.order === null && data.detailsAvailable === false && Number.isInteger(data.orderId);
}

// POST /api/orders  { customerId, items: [{ productId, quantity }] }  ->  201
// Resolves to one of:
//   { order, partial: false }                                  the saved order, read back from the server
//   { order: null, partial: true, orderId, status, totalAmount }  saved, but its details could not be loaded
// Errors are thrown (ApiError / NetworkError): 400 { fields }, 409 for an inactive customer or product.
// Prices, totals and status are never sent: the server decides them.
export async function createOrder({ customerId, items }) {
  const data = await apiRequest('/api/orders', {
    method: 'POST',
    body: { customerId, items: items.map(({ productId, quantity }) => ({ productId, quantity })) },
  });
  if (data && data.order) {
    return { order: data.order, partial: false };
  }
  if (isSavedWithoutDetails(data)) {
    return { order: null, partial: true, orderId: data.orderId, status: data.status, totalAmount: data.totalAmount };
  }
  throw new UnexpectedResponseError();
}

// POST /api/orders/:id/confirm | cancel | ship | deliver  ->  200
// Resolves to { order, partial: false } or { order: null, partial: true, orderId, status } (changed, details not loaded).
// Errors are thrown: 404, 409 { currentStatus } or { shortages } or { productIds }, 503 (busy, nothing changed).
export async function orderAction(id, action) {
  if (!ORDER_ACTIONS.includes(action)) {
    throw new Error(`Unknown order action: ${action}`);
  }
  const data = await apiRequest(`/api/orders/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
  if (data && data.order) {
    return { order: data.order, partial: false };
  }
  if (isSavedWithoutDetails(data)) {
    return { order: null, partial: true, orderId: data.orderId, status: data.status };
  }
  throw new UnexpectedResponseError();
}
