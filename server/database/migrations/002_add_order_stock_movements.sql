-- Migration 002: link stock movements to orders (stock_adjustments gets an order reference and a movement type).
-- For a database that already has migration 001 (or a schema.sql from before this change). A database created
-- from the current schema.sql already has these columns, so do not run this file on it (it would stop with
-- "Duplicate column name").
-- Run by the ADMIN account (inventory_app has no ALTER privilege), once per database, by hand, BEFORE
-- confirming or cancelling any order with the new application code.
-- It only adds two columns, one unique key and one foreign key to stock_adjustments. No row is changed or
-- removed and there are no DROP statements. Existing rows become movement_type 'MANUAL' with no order.

SET NAMES utf8mb4;

ALTER TABLE stock_adjustments
  ADD COLUMN order_id      BIGINT UNSIGNED NULL
    COMMENT 'the order that caused this movement; NULL for manual corrections' AFTER admin_id,
  ADD COLUMN movement_type ENUM('MANUAL','ORDER_CONFIRMED','ORDER_CANCELLED') NOT NULL DEFAULT 'MANUAL'
    COMMENT 'why stock moved: a manual correction, an order confirmation (deduction) or a cancellation (restore)' AFTER order_id,
  -- Safety net for "exactly once": one deduction and at most one restore per product per order. MySQL allows many
  -- NULL order_id values in a unique key, so manual corrections are not affected. The key also serves the foreign key.
  ADD UNIQUE KEY uq_stock_adjustments_order_product_type (order_id, product_id, movement_type),
  ADD CONSTRAINT fk_stock_adjustments_order FOREIGN KEY (order_id) REFERENCES orders (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;
