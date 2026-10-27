// MySQL connection pool. The pool is created on first use, so importing this file
// never opens a connection. All application SQL must use ? placeholders.
const mysql = require('mysql2/promise');
const env = require('./env');

let pool = null;

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

module.exports = { getPool, withTransaction, closePool };
