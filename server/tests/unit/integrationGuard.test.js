// The statement guard of the integration-test helpers (tests/helpers/integrationEnv.js). Pure function: no database is
// touched. It decides which SQL the integration fixtures and assertions may send to inventory_test: only SELECT, INSERT
// and UPDATE, and never a statement that names a database.
const { assertFixtureStatement } = require('../helpers/integrationEnv');

describe('assertFixtureStatement', () => {
  test.each([
    ['a plain SELECT', 'SELECT id FROM products WHERE id = ?'],
    ['a SELECT COUNT', 'SELECT COUNT(*) AS n FROM `orders`'],
    ['an INSERT', 'INSERT INTO customers (name, email) VALUES (?, ?)'],
    ['a multi-line INSERT', 'INSERT INTO stock_adjustments (product_id, quantity_delta)\n VALUES (?, ?)'],
    ['an UPDATE', 'UPDATE products SET stock_quantity = ? WHERE id = ?'],
    ['an UPDATE of created_at / updated_at columns', 'UPDATE orders SET created_at = ?, updated_at = ? WHERE id = ?'],
    ['lower-case keywords', 'select 1'],
    ['leading whitespace', '   SELECT 1'],
  ])('accepts %s', (_name, sql) => {
    expect(() => assertFixtureStatement(sql)).not.toThrow();
  });

  test.each([
    ['DELETE', 'DELETE FROM products'],
    ['TRUNCATE', 'TRUNCATE TABLE products'],
    ['DROP', 'DROP TABLE products'],
    ['ALTER', 'ALTER TABLE products ADD COLUMN x INT'],
    ['CREATE', 'CREATE TABLE x (id INT)'],
    ['GRANT', 'GRANT ALL ON *.* TO someone'],
    ['USE', 'USE inventory_dev'],
    ['SET', 'SET time_zone = "+00:00"'],
    ['SHOW', 'SHOW TABLES'],
    ['a destructive word hidden after a valid start', 'SELECT 1; DROP TABLE products'],
    ['a DELETE after an UPDATE', 'UPDATE products SET name = ? WHERE id = ?; DELETE FROM products'],
    ['an empty statement', ''],
    ['a non-string', null],
  ])('refuses %s', (_name, sql) => {
    expect(() => assertFixtureStatement(sql)).toThrow(/SELECT, INSERT and UPDATE/);
  });

  test.each([
    ['the development database by name', 'UPDATE inventory_dev.products SET name = ? WHERE id = ?'],
    ['the development database in a SELECT', 'SELECT * FROM inventory_dev.products'],
    ['the test database written as a qualified name', 'SELECT id FROM inventory_test.products'],
    ['any inventory_* name', 'SELECT id FROM products WHERE 1 = (SELECT 1 FROM inventory_prod_copy)'],
    ['a backtick-quoted qualified name', 'SELECT id FROM `other`.`products`'],
    ['a dotted table.column name', 'SELECT products.id FROM products'],
    ['the information schema', 'SELECT table_name FROM information_schema'],
    ['the mysql system schema', 'SELECT user FROM mysql'],
  ])('refuses a statement that names %s', (_name, sql) => {
    expect(() => assertFixtureStatement(sql)).toThrow(/may not name a database/);
  });
});
