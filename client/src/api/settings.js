// The settings endpoints under /api/settings (all require a signed-in administrator).
import { apiRequest } from './client.js';
import { UnexpectedResponseError } from './products.js';

function thresholdFrom(settings) {
  if (!settings || !Number.isInteger(settings.lowStockThreshold)) {
    throw new UnexpectedResponseError();
  }
  return settings;
}

// GET /api/settings  ->  200 {
//   settings: { lowStockThreshold },                       5 until a different value has been saved
//   app: { name, serverVersion, clientVersion, environment }   safe facts only; a version can be null; environment is
//                                                          "development" or "production"
// }
export async function getSettings({ signal } = {}) {
  const data = await apiRequest('/api/settings', { signal });
  if (!data || !data.app || typeof data.app !== 'object') {
    throw new UnexpectedResponseError();
  }
  return { settings: thresholdFrom(data.settings), app: data.app };
}

// PATCH /api/settings  { lowStockThreshold: 0..1000 }  ->  200 { settings: { lowStockThreshold } }
// Errors are thrown (ApiError / NetworkError): 400 { fields: ['lowStockThreshold'] } for a value outside the rules.
export async function updateSettings({ lowStockThreshold }) {
  const data = await apiRequest('/api/settings', { method: 'PATCH', body: { lowStockThreshold } });
  return thresholdFrom(data && data.settings);
}
