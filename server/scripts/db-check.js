// Checks that the app can reach MySQL and that the expected tables, columns, indexes and foreign keys exist.
// READ-ONLY: it only runs SELECT statements on information_schema.
// Prints only a short status. It never prints credentials or the connection settings.
// "--env=test" switches to the test configuration for this one process only, so nothing
// needs to be set in the terminal (a leftover NODE_ENV would affect later commands).
if (process.argv.includes('--env=test')) {
  process.env.NODE_ENV = 'test';
}

const env = require('../src/config/env');
const { getPool, closePool } = require('../src/config/db');
const { evaluateSchema } = require('./dbCheckModel');

// Reads the structure of the connected database, but only for the tables this check cares about.
async function readSchema(pool) {
  const [tables] = await pool.query(
    'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()'
  );
  const [columns] = await pool.query(
    'SELECT table_name AS tbl, column_name AS name FROM information_schema.columns WHERE table_schema = DATABASE()'
  );
  const [indexes] = await pool.query(
    'SELECT DISTINCT table_name AS tbl, index_name AS name FROM information_schema.statistics WHERE table_schema = DATABASE()'
  );
  const [keys] = await pool.query(
    `SELECT table_name AS tbl, constraint_name AS name, referenced_table_name AS ref
       FROM information_schema.key_column_usage
      WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL`
  );
  return {
    tables: new Set(tables.map((t) => t.name)),
    columns: new Set(columns.map((c) => `${c.tbl}.${c.name}`)),
    indexes: new Set(indexes.map((i) => `${i.tbl}.${i.name}`)),
    foreignKeys: new Map(keys.map((k) => [`${k.tbl}.${k.name}`, k.ref])),
  };
}

function report(result) {
  let healthy = true;

  if (result.missingBaseTables.length > 0) {
    console.log(`Missing tables: ${result.missingBaseTables.join(', ')} (has schema.sql been applied?)`);
    healthy = false;
  } else {
    console.log('All original tables are present.');
  }

  for (const migration of result.migrations) {
    console.log(`\nMigration ${migration.id}:`);
    for (const piece of migration.pieces) {
      for (const item of piece.items) {
        console.log(`  ${item.ok ? 'ok     ' : 'MISSING'}  ${item.label}`);
      }
    }
    if (migration.state === 'applied') {
      console.log(`  -> Migration ${migration.id} is fully applied.`);
    } else if (migration.state === 'not-applied') {
      console.log(`  -> Migration ${migration.id} is NOT applied. Apply it once (see server/database/SETUP.md).`);
      healthy = false;
    } else {
      console.log(`  -> PARTIAL MIGRATION ${migration.id} — DO NOT RERUN THE FULL FILE.`);
      console.log('     Follow "Recovery" in server/database/SETUP.md: run only the statement(s) that are missing.');
      healthy = false;
    }
  }
  return healthy;
}

async function main() {
  env.assertDbConfig();
  const pool = getPool();
  const [[row]] = await pool.query('SELECT DATABASE() AS db');
  console.log(`Connected to database: ${row.db}`);

  const result = evaluateSchema(await readSchema(pool));
  if (!report(result)) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    // err.code is a short category such as ER_ACCESS_DENIED_ERROR; the message may contain host/user.
    console.error(`Database check failed: ${err.code || String(err.message).split('\n')[0]}`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
