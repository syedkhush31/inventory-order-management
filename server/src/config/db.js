// MySQL connection pool. The pool is created on first use, so importing this file
// never opens a connection. All application SQL must use ? placeholders.
const mysql = require('mysql2/promise');
const env = require('./env');

let pool = null;

// Every pooled connection runs in UTC. TIMESTAMP columns are stored as UTC instants but MySQL returns them
// in the session time zone, which defaults to the server's (SYSTEM). mysql2 below is told `timezone: 'Z'`,
// i.e. "the text I receive is UTC", so the session must really be UTC or every timestamp is shifted.
// The offset form needs no time-zone tables on the server. The two settings must always change together.
const SESSION_TIME_ZONE = '+00:00';

// Runs once for each NEW connection, right after it connects and before the pool hands it to the caller.
// The SET becomes the connection's active command, so any query the caller sends is queued behind it
// and cannot run before it has finished. If the SET fails, destroy() closes the stream and removes the
// connection from the pool (it is never reused); a query already queued on it fails instead of running
// with an unknown time zone. Only a short error code is logged: never SQL, host or credentials.
function initialiseConnection(connection) {
  const discard = (err) => {
    connection.destroy();
    console.error(`Database session setup failed: ${(err && (err.code || err.name)) || 'unknown error'}`);
  };
  try {
    connection.query(`SET time_zone = '${SESSION_TIME_ZONE}'`, (err) => {
      if (err) discard(err);
    });
  } catch (err) {
    discard(err);
  }
}

function getPool() {
  if (!pool) {
    env.assertDbConfig();
    pool = mysql.createPool({
      host: env.db.host,
      port: env.db.port,
      database: env.db.name,
      user: env.db.user,
      password: env.db.password,
      charset: 'utf8mb4',
      timezone: 'Z',
      connectionLimit: 10,
      waitForConnections: true,
      queueLimit: 0,
      decimalNumbers: false, // DECIMAL columns come back as exact strings, not floats
    });
    pool.on('connection', initialiseConnection);
  }
  return pool;
}

// Runs fn(connection) inside one transaction: commit on success, rollback on any error.
async function withTransaction(fn) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (err) {
    try {
      await connection.rollback();
    } catch (rollbackErr) {
      // The original error is more useful than a failed rollback.
    }
    throw err;
  } finally {
    connection.release();
  }
}

async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

module.exports = { getPool, withTransaction, closePool, SESSION_TIME_ZONE };
