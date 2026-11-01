// Application preferences stored in app_settings. Right now there is one: the low-stock threshold.
const settingsRepository = require('../repositories/settingsRepository');
const auditService = require('./auditService');
const { withTransaction } = require('../config/db');
const {
  LOW_STOCK_THRESHOLD_KEY,
  DEFAULT_LOW_STOCK_THRESHOLD,
  MIN_LOW_STOCK_THRESHOLD,
  MAX_LOW_STOCK_THRESHOLD,
} = require('../validation/settingsSchemas');

// The stored text as a number. A missing row, or text that is not a whole number in range (it should never be,
// because only this service writes it), gives the default instead of a broken value.
function thresholdFrom(stored) {
  if (typeof stored !== 'string' || !/^\d{1,4}$/.test(stored)) return DEFAULT_LOW_STOCK_THRESHOLD;
  const value = Number(stored);
  return value >= MIN_LOW_STOCK_THRESHOLD && value <= MAX_LOW_STOCK_THRESHOLD ? value : DEFAULT_LOW_STOCK_THRESHOLD;
}

// { lowStockThreshold } with the saved value, or 5 when nothing has been saved.
async function getSettings() {
  return { lowStockThreshold: thresholdFrom(await settingsRepository.getValue(LOW_STOCK_THRESHOLD_KEY)) };
}

// Saves the given settings and, if the effective value really changes, records the change in the audit log in the same
// transaction. adminId is the signed-in administrator.
//
// Why it is built this way (two administrators saving for the first time at the same moment must not collide):
//  1. A plain read first. Sending the value that is already in force (the saved one, or the default when nothing is
//     saved) stops here: no write is sent and nothing is audited.
//  2. ensureRow: one atomic INSERT ... ON DUPLICATE KEY UPDATE that creates the row (holding the default, which changes
//     nothing) if it is missing, and takes its lock. There is no "check, then insert" gap for a second saver to fall into.
//  3. The row is read again under that lock, so the audit record's "from" is the real value, not a stale one. If someone
//     else already saved this very value in the meantime, there is nothing to do.
//  4. upsert: the one atomic INSERT ... ON DUPLICATE KEY UPDATE that stores the new value, then the audit record.
async function updateSettings(adminId, { lowStockThreshold }) {
  await withTransaction(async (connection) => {
    const seen = thresholdFrom(await settingsRepository.getValue(LOW_STOCK_THRESHOLD_KEY, connection));
    if (seen === lowStockThreshold) {
      return;
    }

    await settingsRepository.ensureRow(connection, {
      key: LOW_STOCK_THRESHOLD_KEY,
      defaultValue: String(DEFAULT_LOW_STOCK_THRESHOLD),
    });
    const current = thresholdFrom(await settingsRepository.getValueForUpdate(connection, LOW_STOCK_THRESHOLD_KEY));
    if (current === lowStockThreshold) {
      return;
    }

    await settingsRepository.upsert(connection, { key: LOW_STOCK_THRESHOLD_KEY, value: String(lowStockThreshold), adminId });
    // Only the setting's name and the two numbers: no request body is passed on.
    await auditService.record(connection, {
      adminId,
      eventType: 'SETTINGS_UPDATED',
      details: { key: LOW_STOCK_THRESHOLD_KEY, from: current, to: lowStockThreshold },
    });
  });
  return getSettings();
}

module.exports = { getSettings, updateSettings, thresholdFrom };
