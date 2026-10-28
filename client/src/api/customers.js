// The customer endpoints under /api/customers (all require a signed-in administrator).
import { apiRequest } from './client.js';
import { UnexpectedResponseError } from './products.js';

// params: { q, status, page, pageSize, sort, order }
// Returns { items, page, pageSize, total, totalPages }. Each item is
// { id, name, email, phone, address, isActive, createdAt, updatedAt } (phone and address may be null).
export function listCustomers({ q, status, page, pageSize, sort, order }, { signal } = {}) {
  const query = new URLSearchParams();
  if (q) query.set('q', q);
  query.set('status', status);
  query.set('page', String(page));
  query.set('pageSize', String(pageSize));
  query.set('sort', sort);
  query.set('order', order);
  return apiRequest(`/api/customers?${query.toString()}`, { signal });
}

// A reply that says "ok" but has no customer cannot be trusted as a confirmed save.
function customerFrom(data) {
  if (!data || !data.customer) {
    throw new UnexpectedResponseError();
  }
  return data.customer;
}

// POST /api/customers  { name, email, phone?, address? }  ->  201 { customer }
// Errors are thrown (ApiError / NetworkError): 400 { fields } for invalid input, 409 { fields: ['email'] } for a duplicate email.
export async function createCustomer({ name, email, phone, address }) {
  return customerFrom(await apiRequest('/api/customers', { method: 'POST', body: { name, email, phone, address } }));
}

// PATCH /api/customers/:id  { name?, email?, phone?, address? }  ->  200 { customer }
// Sends only the fields given. null (or "") clears phone or address. 404 for an unknown customer.
export async function updateCustomer(id, { name, email, phone, address }) {
  const changes = {};
  if (name !== undefined) changes.name = name;
  if (email !== undefined) changes.email = email;
  if (phone !== undefined) changes.phone = phone;
  if (address !== undefined) changes.address = address;
  return customerFrom(
    await apiRequest(`/api/customers/${encodeURIComponent(id)}`, { method: 'PATCH', body: changes })
  );
}

// POST /api/customers/:id/deactivate or /reactivate  ->  200 { customer }. Nothing is deleted.
export async function setCustomerActive(id, isActive) {
  const action = isActive ? 'reactivate' : 'deactivate';
  return customerFrom(
    await apiRequest(`/api/customers/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} })
  );
}
