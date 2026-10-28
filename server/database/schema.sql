-- Inventory & Order Management schema. MySQL 8, InnoDB, utf8mb4.
-- Run by the ADMIN account against an already-created, EMPTY database
-- (see SETUP.md). It does not create or drop databases and has no DROP statements:
-- if a table already exists, the script stops with an error instead of overwriting it.

SET NAMES utf8mb4;

CREATE TABLE admins (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email         VARCHAR(255)    NOT NULL,
  password_hash VARCHAR(255)    NOT NULL COMMENT 'bcrypt hash only, never a plaintext password',
  is_active     TINYINT(1)      NOT NULL DEFAULT 1,
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admins_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE products (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sku            VARCHAR(64)     NOT NULL,
  name           VARCHAR(255)    NOT NULL,
  price          DECIMAL(10,2)   NOT NULL,
  stock_quantity INT UNSIGNED    NOT NULL DEFAULT 0,
  is_active      TINYINT(1)      NOT NULL DEFAULT 1 COMMENT 'soft delete: products used by orders are never removed',
  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_products_sku (sku),
  KEY idx_products_name (name),
  CONSTRAINT chk_products_price_nonneg CHECK (price >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
-- stock_quantity is UNSIGNED, so MySQL itself rejects any update that would make stock negative.

CREATE TABLE customers (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(255)    NOT NULL,
  email      VARCHAR(255)    NOT NULL,
  phone      VARCHAR(32)     NULL,
  address    VARCHAR(500)    NULL,
  is_active  TINYINT(1)      NOT NULL DEFAULT 1 COMMENT 'soft delete: customers with orders are never removed',
  created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customers_email (email),
  KEY idx_customers_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE orders (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id  BIGINT UNSIGNED NOT NULL,
  status       ENUM('PENDING','CONFIRMED','SHIPPED','DELIVERED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  total_amount DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_orders_customer_created (customer_id, created_at),
  KEY idx_orders_status_created (status, created_at),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_orders_total_nonneg CHECK (total_amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE order_items (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id   BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  quantity   INT UNSIGNED    NOT NULL,
  unit_price DECIMAL(10,2)   NOT NULL COMMENT 'price at the time of ordering (snapshot)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_order_items_order_product (order_id, product_id),
  KEY idx_order_items_product (product_id),
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES products (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_order_items_quantity_positive CHECK (quantity > 0),
  CONSTRAINT chk_order_items_price_nonneg CHECK (unit_price >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE order_status_history (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id            BIGINT UNSIGNED NOT NULL,
  from_status         ENUM('PENDING','CONFIRMED','SHIPPED','DELIVERED','CANCELLED') NULL COMMENT 'NULL for the initial PENDING record',
  to_status           ENUM('PENDING','CONFIRMED','SHIPPED','DELIVERED','CANCELLED') NOT NULL,
  changed_by_admin_id BIGINT UNSIGNED NOT NULL,
  changed_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_osh_order_changed (order_id, changed_at),
  KEY idx_osh_admin (changed_by_admin_id),
  CONSTRAINT fk_osh_order FOREIGN KEY (order_id) REFERENCES orders (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_osh_admin FOREIGN KEY (changed_by_admin_id) REFERENCES admins (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Every stock movement made through the app: manual corrections and order confirmations / cancellations.
-- Added after the first release: an older database gets the table from migrations/001_add_stock_adjustments.sql and
-- the order columns from migrations/002_add_order_stock_movements.sql instead of re-running this whole file.
CREATE TABLE stock_adjustments (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id     BIGINT UNSIGNED NOT NULL,
  quantity_delta INT             NOT NULL COMMENT 'signed change applied to stock_quantity, never 0',
  reason         VARCHAR(255)    NOT NULL,
  admin_id       BIGINT UNSIGNED NOT NULL COMMENT 'the administrator who made the correction',
  order_id       BIGINT UNSIGNED NULL COMMENT 'the order that caused this movement; NULL for manual corrections',
  movement_type  ENUM('MANUAL','ORDER_CONFIRMED','ORDER_CANCELLED') NOT NULL DEFAULT 'MANUAL'
    COMMENT 'why stock moved: a manual correction, an order confirmation (deduction) or a cancellation (restore)',
  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_stock_adjustments_product_created (product_id, created_at),
  KEY idx_stock_adjustments_admin (admin_id),
  -- Safety net for "exactly once": one deduction and at most one restore per product per order.
  -- MySQL allows many NULL order_id values in a unique key, so manual corrections are not affected.
  UNIQUE KEY uq_stock_adjustments_order_product_type (order_id, product_id, movement_type),
  CONSTRAINT fk_stock_adjustments_product FOREIGN KEY (product_id) REFERENCES products (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_stock_adjustments_admin FOREIGN KEY (admin_id) REFERENCES admins (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_stock_adjustments_order FOREIGN KEY (order_id) REFERENCES orders (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_stock_adjustments_delta_nonzero CHECK (quantity_delta <> 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
