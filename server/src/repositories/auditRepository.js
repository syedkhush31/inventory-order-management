// All SQL that WRITES to audit_log. The log is append-only: this file only ever INSERTs. There is no update or
// delete function on purpose (and a unit test checks that no source file runs UPDATE or DELETE on audit_log).
// Reading the log for the Activity page is done by activityRepository.
//
// insert() needs the `connection` of an open transaction (see withTransaction in config/db.js), so the log row is
// saved or discarded together with the change it describes. A connection pool is refused.

// A pool has getConnection(); a single transaction connection does not.
function assertTransactionConnection(connection) {
  if (!connection || typeof connection.query !== 'function' || typeof connection.getConnection === 'function') {
    throw new Error('audit_log writes need the connection of an open transaction, not the pool');
  }
}

// entityType and details have already been checked by auditService. details is null or a plain object.
async function insert(connection, { adminId, eventType, entityType, entityId, details }) {
  assertTransactionConnection(connection);
  const [result] = await connection.query(
    'INSERT INTO audit_log (admin_id, event_type, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)',
    [adminId, eventType, entityType, entityId, details === null ? null : JSON.stringify(details)]
  );
  return result.insertId;
}

module.exports = { insert };
