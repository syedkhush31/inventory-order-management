// Records audit events. Every call is checked against the strict allowlists in validation/auditSchemas.js, and
// must run on the connection of the transaction that holds the change being described, so the log row and the
// change commit or roll back together. Callers build `details` themselves from values they computed (field names, a
// validated price, whole numbers): a request body is never passed in, and anything off the allowlist is refused.
const auditRepository = require('../repositories/auditRepository');
const { AuditValidationError, validateAuditEvent } = require('../validation/auditSchemas');

const MAX_ADMIN_ID = 999_999_999_999_999;

// connection: the transaction connection from withTransaction().
// event: { adminId, eventType, entityId, details? }. Resolves to the new audit_log id.
// Throws AuditValidationError (nothing is written) when the event is not allowed.
async function record(connection, { adminId, eventType, entityId = null, details = null }) {
  if (!Number.isSafeInteger(adminId) || adminId < 1 || adminId > MAX_ADMIN_ID) {
    throw new AuditValidationError('A valid administrator id is required');
  }
  const event = validateAuditEvent({ eventType, entityId, details });
  return auditRepository.insert(connection, { adminId, ...event });
}

module.exports = { record, AuditValidationError };
