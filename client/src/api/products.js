// The product list endpoint: GET /api/products (requires a signed-in administrator).
import { apiRequest } from './client.js';

// params: { q, status, page, pageSize, sort, order }
// Returns { items, page, pageSize, total, totalPages }. See the server's productService for the item fields.
export function listProducts({ q, status, page, pageSize, sort, order }, { signal } = {}) {
  const query = new URLSearchParams();
  if (q) query.set('q', q);
  query.set('status', status);
  query.set('page', String(page));
  query.set('pageSize', String(pageSize));
  query.set('sort', sort);
  query.set('order', order);
  return apiRequest(`/api/products?${query.toString()}`, { signal });
}

// POST /api/products  { sku, name, price: "19.99", stockQuantity }  ->  201 { product }
// Returns the created product exactly as the server saved it. Errors are thrown (ApiError / NetworkError):
// 400 { error, fields: [...] } for invalid input and 409 { error, fields: ['sku'] } for a duplicate SKU.
// Thrown when the server says "created" but the reply does not contain the product, so we cannot confirm the save.
export class UnexpectedResponseError extends Error {
  constructor() {
    super('The server reply was not understood');
    this.name = 'UnexpectedResponseError';
  }
}

export async function createProduct({ sku, name, price, stockQuantity }) {
  const data = await apiRequest('/api/products', {
    method: 'POST',
    body: { sku, name, price, stockQuantity },
  });
  if (!data || !data.product) {
    throw new UnexpectedResponseError();
  }
  return data.product;
}

// PATCH /api/products/:id  { sku?, name?, price? }  ->  200 { product }
// Sends only the fields given (the server rejects anything else). Errors are thrown like createProduct's:
// 400 { fields }, 404 for an unknown product and 409 { fields: ['sku'] } for a duplicate SKU.
export async function updateProduct(id, { sku, name, price }) {
  const changes = {};
  if (sku !== undefined) changes.sku = sku;
  if (name !== undefined) changes.name = name;
  if (price !== undefined) changes.price = price;

  const data = await apiRequest(`/api/products/${encodeURIComponent(id)}`, { method: 'PATCH', body: changes });
  if (!data || !data.product) {
    throw new UnexpectedResponseError();
  }
  return data.product;
}

// POST /api/products/:id/deactivate or /reactivate  ->  200 { product }. Repeating either is harmless.
export async function setProductActive(id, isActive) {
  const action = isActive ? 'reactivate' : 'deactivate';
  const data = await apiRequest(`/api/products/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
  if (!data || !data.product) {
    throw new UnexpectedResponseError();
  }
  return data.product;
}

// POST /api/products/:id/stock-adjustments  { delta, reason }  ->  201 { product, adjustment }
// delta is a signed whole number (-3 removes three). The server refuses to let stock go below 0:
// 409 { fields: ['delta'], currentStock } carries the real number on hand.
export async function adjustStock(id, { delta, reason }) {
  const data = await apiRequest(`/api/products/${encodeURIComponent(id)}/stock-adjustments`, {
    method: 'POST',
    body: { delta, reason },
  });
  if (!data || !data.product || !data.adjustment) {
    throw new UnexpectedResponseError();
  }
  return data;
}

// GET /api/products/:id/stock-adjustments?page=&pageSize=
// Returns { items, page, pageSize, total, totalPages }, newest first. Each item is
// { id, productId, quantityDelta, reason, adminId, createdAt }. 404 for an unknown product.
export function listStockAdjustments(id, { page, pageSize }, { signal } = {}) {
  const query = new URLSearchParams();
  query.set('page', String(page));
  query.set('pageSize', String(pageSize));
  return apiRequest(`/api/products/${encodeURIComponent(id)}/stock-adjustments?${query.toString()}`, { signal });
}
