// What db-check expects to find, and the logic that compares it with what the database has.
// Pure functions only: nothing here connects to a database, reads the environment or prints anything.

// Tables that the original schema.sql created. Migration 003 adds audit_log and app_settings (see MIGRATIONS).
const BASE_TABLES = ['admins', 'products', 'customers', 'orders', 'order_items', 'order_status_history', 'stock_adjustments'];

// Each migration is a list of "pieces": one table, or the columns added to an existing table. A piece is
// 'present' when every item below is there, 'missing' when none is, and 'incomplete' when only some are.
// foreignKeys: [{ name, references }] where references is the table the key points at.
const MIGRATIONS = [
  {
    id: '002',
    pieces: [
      {
        name: 'stock_adjustments order columns',
        table: 'stock_adjustments',
        ownsTable: false,
        columns: ['order_id', 'movement_type'],
        indexes: ['uq_stock_adjustments_order_product_type'],
        foreignKeys: [{ name: 'fk_stock_adjustments_order', references: 'orders' }],
      },
    ],
  },
  {
    id: '003',
    pieces: [
      {
        name: 'audit_log',
        table: 'audit_log',
        ownsTable: true,
        columns: ['id', 'occurred_at', 'admin_id', 'event_type', 'entity_type', 'entity_id', 'details'],
        indexes: ['idx_audit_log_occurred', 'idx_audit_log_admin', 'idx_audit_log_entity'],
        foreignKeys: [{ name: 'fk_audit_log_admin', references: 'admins' }],
      },
      {
        name: 'app_settings',
        table: 'app_settings',
        ownsTable: true,
        columns: ['setting_key', 'setting_value', 'updated_by_admin_id', 'updated_at'],
        indexes: [],
        foreignKeys: [{ name: 'fk_app_settings_admin', references: 'admins' }],
      },
      {
        name: 'admins columns',
        table: 'admins',
        ownsTable: false,
        columns: ['display_name', 'token_version'],
        indexes: [],
        foreignKeys: [],
      },
    ],
  },
];

// schema: { tables: Set<string>, columns: Set<'table.column'>, indexes: Set<'table.index'>,
//           foreignKeys: Map<'table.constraint', referencedTable> }
function evaluatePiece(piece, schema) {
  const items = [];
  if (piece.ownsTable) {
    items.push({ label: `table ${piece.table}`, ok: schema.tables.has(piece.table) });
  }
  for (const column of piece.columns) {
    items.push({ label: `column ${piece.table}.${column}`, ok: schema.columns.has(`${piece.table}.${column}`) });
  }
  for (const index of piece.indexes) {
    items.push({ label: `index ${piece.table}.${index}`, ok: schema.indexes.has(`${piece.table}.${index}`) });
  }
  for (const key of piece.foreignKeys) {
    items.push({
      label: `foreign key ${piece.table}.${key.name} -> ${key.references}`,
      ok: schema.foreignKeys.get(`${piece.table}.${key.name}`) === key.references,
    });
  }
  const present = items.filter((item) => item.ok).length;
  const state = present === items.length ? 'present' : present === 0 ? 'missing' : 'incomplete';
  return { name: piece.name, state, items };
}

// state: 'applied' (every piece present), 'not-applied' (every piece missing) or 'partial' (anything else).
function evaluateMigration(migration, schema) {
  const pieces = migration.pieces.map((piece) => evaluatePiece(piece, schema));
  const state = pieces.every((p) => p.state === 'present')
    ? 'applied'
    : pieces.every((p) => p.state === 'missing')
      ? 'not-applied'
      : 'partial';
  return { id: migration.id, state, pieces };
}

function evaluateSchema(schema, { baseTables = BASE_TABLES, migrations = MIGRATIONS } = {}) {
  return {
    missingBaseTables: baseTables.filter((table) => !schema.tables.has(table)),
    migrations: migrations.map((migration) => evaluateMigration(migration, schema)),
  };
}

module.exports = { BASE_TABLES, MIGRATIONS, evaluatePiece, evaluateMigration, evaluateSchema };
