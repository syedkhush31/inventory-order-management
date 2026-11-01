// db-check's comparison logic and the migration 003 files. Pure functions and text files: no database is touched.
const fs = require('fs');
const path = require('path');
const { BASE_TABLES, MIGRATIONS, evaluateSchema } = require('../../scripts/dbCheckModel');

const databaseDir = path.join(__dirname, '..', '..', 'database');
const migrationSql = fs.readFileSync(path.join(databaseDir, 'migrations', '003_add_audit_log_and_settings.sql'), 'utf8');
const schemaSql = fs.readFileSync(path.join(databaseDir, 'schema.sql'), 'utf8');

// A schema that has everything every migration expects. Tests remove pieces from it.
function fullSchema() {
  const schema = {
    tables: new Set(BASE_TABLES),
    columns: new Set(),
    indexes: new Set(),
    foreignKeys: new Map(),
  };
  for (const migration of MIGRATIONS) {
    for (const piece of migration.pieces) {
      if (piece.ownsTable) schema.tables.add(piece.table);
      piece.columns.forEach((c) => schema.columns.add(`${piece.table}.${c}`));
      piece.indexes.forEach((i) => schema.indexes.add(`${piece.table}.${i}`));
      piece.foreignKeys.forEach((k) => schema.foreignKeys.set(`${piece.table}.${k.name}`, k.references));
    }
  }
  return schema;
}

const stateOf = (schema, id) => evaluateSchema(schema).migrations.find((m) => m.id === id);
const pieceOf = (migration, name) => migration.pieces.find((p) => p.name === name);

function dropTable(schema, table) {
  schema.tables.delete(table);
  for (const set of [schema.columns, schema.indexes]) {
    for (const key of [...set]) if (key.startsWith(`${table}.`)) set.delete(key);
  }
  for (const key of [...schema.foreignKeys.keys()]) if (key.startsWith(`${table}.`)) schema.foreignKeys.delete(key);
}

function dropAdminColumns(schema) {
  schema.columns.delete('admins.display_name');
  schema.columns.delete('admins.token_version');
}

describe('db-check: migration state', () => {
  test('a database with everything is fully applied and lists no missing base tables', () => {
    const result = evaluateSchema(fullSchema());
    expect(result.missingBaseTables).toEqual([]);
    expect(result.migrations.map((m) => [m.id, m.state])).toEqual([
      ['002', 'applied'],
      ['003', 'applied'],
    ]);
  });

  test('a database from before migration 003 is "not-applied", every 003 item missing', () => {
    const schema = fullSchema();
    dropTable(schema, 'audit_log');
    dropTable(schema, 'app_settings');
    dropAdminColumns(schema);
    const m003 = stateOf(schema, '003');
    expect(m003.state).toBe('not-applied');
    expect(m003.pieces.every((p) => p.state === 'missing')).toBe(true);
    expect(stateOf(schema, '002').state).toBe('applied');
  });

  test('audit_log created but app_settings and the admins columns missing is PARTIAL', () => {
    const schema = fullSchema();
    dropTable(schema, 'app_settings');
    dropAdminColumns(schema);
    const m003 = stateOf(schema, '003');
    expect(m003.state).toBe('partial');
    expect(pieceOf(m003, 'audit_log').state).toBe('present');
    expect(pieceOf(m003, 'app_settings').state).toBe('missing');
    expect(pieceOf(m003, 'admins columns').state).toBe('missing');
  });

  test('both tables created but the admins columns missing is PARTIAL', () => {
    const schema = fullSchema();
    dropAdminColumns(schema);
    const m003 = stateOf(schema, '003');
    expect(m003.state).toBe('partial');
    expect(pieceOf(m003, 'admins columns').state).toBe('missing');
    expect(pieceOf(m003, 'audit_log').state).toBe('present');
  });

  test('only one admins column present makes that piece incomplete and the migration PARTIAL', () => {
    const schema = fullSchema();
    schema.columns.delete('admins.token_version');
    dropTable(schema, 'audit_log');
    dropTable(schema, 'app_settings');
    const m003 = stateOf(schema, '003');
    expect(pieceOf(m003, 'admins columns').state).toBe('incomplete');
    expect(m003.state).toBe('partial');
  });

  test('a table that exists but lacks an index, a column or its foreign key is incomplete', () => {
    for (const remove of [
      (s) => s.indexes.delete('audit_log.idx_audit_log_occurred'),
      (s) => s.columns.delete('audit_log.details'),
      (s) => s.foreignKeys.delete('audit_log.fk_audit_log_admin'),
    ]) {
      const schema = fullSchema();
      remove(schema);
      const m003 = stateOf(schema, '003');
      expect(pieceOf(m003, 'audit_log').state).toBe('incomplete');
      expect(m003.state).toBe('partial');
    }
  });

  test('a foreign key that points at the wrong table does not count', () => {
    const schema = fullSchema();
    schema.foreignKeys.set('audit_log.fk_audit_log_admin', 'products');
    expect(pieceOf(stateOf(schema, '003'), 'audit_log').state).toBe('incomplete');
  });

  test('migration 002 missing its columns is "not-applied" and does not affect 003', () => {
    const schema = fullSchema();
    schema.columns.delete('stock_adjustments.order_id');
    schema.columns.delete('stock_adjustments.movement_type');
    schema.indexes.delete('stock_adjustments.uq_stock_adjustments_order_product_type');
    schema.foreignKeys.delete('stock_adjustments.fk_stock_adjustments_order');
    expect(stateOf(schema, '002').state).toBe('not-applied');
    expect(stateOf(schema, '003').state).toBe('applied');
  });

  test('missing original tables are listed by name', () => {
    const schema = fullSchema();
    schema.tables.delete('orders');
    expect(evaluateSchema(schema).missingBaseTables).toEqual(['orders']);
  });

  test('every item is reported separately, each with a label', () => {
    const m003 = stateOf(fullSchema(), '003');
    const labels = m003.pieces.flatMap((p) => p.items.map((i) => i.label));
    expect(labels).toContain('table audit_log');
    expect(labels).toContain('column audit_log.admin_id');
    expect(labels).toContain('index audit_log.idx_audit_log_occurred');
    expect(labels).toContain('foreign key app_settings.fk_app_settings_admin -> admins');
    expect(labels).toContain('column admins.token_version');
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('migration 003 files', () => {
  const squash = (text) => text.replace(/\s+/g, ' ').trim();
  const tableDefinition = (sql, name) => {
    const match = new RegExp(`CREATE TABLE ${name} \\([\\s\\S]*?\\) ENGINE=InnoDB[^;]*;`).exec(sql);
    return match ? squash(match[0]) : null;
  };

  test('audit_log and app_settings are defined identically in the migration and in schema.sql', () => {
    for (const table of ['audit_log', 'app_settings']) {
      const fromMigration = tableDefinition(migrationSql, table);
      expect(fromMigration).not.toBeNull();
      expect(tableDefinition(schemaSql, table)).toBe(fromMigration);
    }
  });

  test('the two admins columns are defined identically in the migration and in schema.sql', () => {
    for (const column of ['display_name', 'token_version']) {
      const inMigration = new RegExp(`ADD COLUMN (${column}\\s[^;]*?)(?:,\\s*ADD COLUMN|;)`).exec(migrationSql);
      const inSchema = new RegExp(`\\n\\s+(${column}\\s[^\\n]*?),?\\n`).exec(schemaSql);
      expect(inMigration).not.toBeNull();
      expect(inSchema).not.toBeNull();
      const normalise = (s) => squash(s).replace(/ AFTER \w+$/, '').replace(/,$/, '');
      expect(normalise(inSchema[1])).toBe(normalise(inMigration[1]));
    }
  });

  test('the enum values are identical in both files and cover every product, customer, account and settings event', () => {
    const enumOf = (sql) => {
      const block = /event_type\s+ENUM\(([\s\S]*?)\)\s+NOT NULL/.exec(sql);
      return block ? block[1].match(/'[A-Z_]+'/g).map((v) => v.slice(1, -1)) : null;
    };
    const values = enumOf(migrationSql);
    expect(enumOf(schemaSql)).toEqual(values);
    expect(values).toEqual([
      'PRODUCT_CREATED',
      'PRODUCT_UPDATED',
      'PRODUCT_ACTIVATED',
      'PRODUCT_DEACTIVATED',
      'CUSTOMER_CREATED',
      'CUSTOMER_UPDATED',
      'CUSTOMER_ACTIVATED',
      'CUSTOMER_DEACTIVATED',
      'ACCOUNT_PROFILE_UPDATED',
      'ACCOUNT_PASSWORD_CHANGED',
      'SETTINGS_UPDATED',
    ]);
    expect(new Set(values).size).toBe(values.length);
    // No value may be a bare suffix such as '_DEACTIVATED': each starts with its entity.
    expect(values.every((v) => /^(PRODUCT|CUSTOMER|ACCOUNT|SETTINGS)_/.test(v))).toBe(true);
  });

  test('the entity_type enum matches in both files', () => {
    const entities = (sql) => /entity_type\s+ENUM\(([^)]*)\)/.exec(sql)[1];
    expect(entities(schemaSql)).toBe(entities(migrationSql));
  });

  test('the migration is additive only: no DROP, TRUNCATE, RENAME, INSERT, UPDATE or DELETE statements', () => {
    const code = migrationSql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .replace(/ON (DELETE|UPDATE) (RESTRICT|CURRENT_TIMESTAMP)/g, '');
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|RENAME|INSERT|UPDATE|DELETE)\b/i);
  });

  test('it has exactly three labelled statements and no semicolons outside statement ends', () => {
    const code = migrationSql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    const statements = code.split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements.map((s) => s.split(/\s+/).slice(0, 3).join(' '))).toEqual([
      'SET NAMES utf8mb4',
      'CREATE TABLE audit_log',
      'CREATE TABLE app_settings',
      'ALTER TABLE admins',
    ]);
    expect(migrationSql).toMatch(/STATEMENT 1 of 3: audit_log/);
    expect(migrationSql).toMatch(/STATEMENT 2 of 3: app_settings/);
    expect(migrationSql).toMatch(/STATEMENT 3 of 3: the two new admins columns/);
  });

  test('audit_log keeps its admin foreign key as RESTRICT and has no column meant for secrets or contact details', () => {
    const definition = tableDefinition(migrationSql, 'audit_log');
    expect(definition).toMatch(
      /fk_audit_log_admin FOREIGN KEY \(admin_id\) REFERENCES admins \(id\) ON DELETE RESTRICT ON UPDATE RESTRICT/
    );
    // Column names only: the event names (such as ACCOUNT_PASSWORD_CHANGED) and the COMMENT texts are not columns.
    const columnNames = [...definition.matchAll(/(?:\(| ,|, )\s*(\w+) (?:BIGINT|TIMESTAMP|ENUM|JSON|VARCHAR|INT)\b/g)].map((m) => m[1]);
    expect(columnNames).toEqual(['id', 'occurred_at', 'admin_id', 'event_type', 'entity_type', 'entity_id', 'details']);
    expect(columnNames.join(' ')).not.toMatch(/password|hash|token|secret|phone|email|address/i);
  });
});
