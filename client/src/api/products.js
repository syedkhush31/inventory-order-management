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
