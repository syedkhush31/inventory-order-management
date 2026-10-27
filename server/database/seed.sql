-- Sample DEVELOPMENT data: products and customers only. No administrators, no passwords.
-- Run by the ADMIN account against inventory_dev only (see SETUP.md).
-- Running it twice fails on the unique SKU/email constraints instead of duplicating rows.

-- Guard: the subquery below returns two rows (an error that stops the script)
-- when the selected database name ends in "_test". In any other database it is harmless.
SELECT IF(DATABASE() LIKE '%\_test', (SELECT 1 UNION ALL SELECT 2), 0) AS seed_guard;

INSERT INTO products (sku, name, price, stock_quantity) VALUES
  ('SKU-1001', 'Wireless Mouse',        19.99, 120),
  ('SKU-1002', 'Mechanical Keyboard',   79.50,  60),
  ('SKU-1003', 'USB-C Cable 1m',         7.25, 300),
  ('SKU-1004', '27-inch Monitor',      189.00,  25),
  ('SKU-1005', 'Laptop Stand',          34.90,  80);

INSERT INTO customers (name, email, phone, address) VALUES
  ('Alice Example', 'alice@example.com', '555-0101', '1 Sample Street, Testville'),
  ('Bob Example',   'bob@example.com',   '555-0102', '2 Sample Street, Testville'),
  ('Carol Example', 'carol@example.com', NULL,       NULL);
