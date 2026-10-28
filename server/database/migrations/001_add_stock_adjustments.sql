-- Migration 001: stock_adjustments (history of manual stock corrections).
-- For a database that was created from an EARLIER schema.sql. A database created from the current
-- schema.sql already has this table, so do not run this file on it (it would stop with "table exists").
-- Run by the ADMIN account (inventory_app has no CREATE privilege), once per database, by hand.
-- It only creates a new table: no existing table or row is changed, and there are no DROP statements.

SET NAMES utf8mb4;

CREATE TABLE stock_adjustments (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id     BIGINT UNSIGNED NOT NULL,
  quantity_delta INT             NOT NULL COMMENT 'signed change applied to stock_quantity, never 0',
  reason         VARCHAR(255)    NOT NULL,
  admin_id       BIGINT UNSIGNED NOT NULL COMMENT 'the administrator who made the correction',
  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_stock_adjustments_product_created (product_id, created_at),
  KEY idx_stock_adjustments_admin (admin_id),
  CONSTRAINT fk_stock_adjustments_product FOREIGN KEY (product_id) REFERENCES products (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_stock_adjustments_admin FOREIGN KEY (admin_id) REFERENCES admins (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_stock_adjustments_delta_nonzero CHECK (quantity_delta <> 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
