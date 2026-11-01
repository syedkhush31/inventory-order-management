-- Migration 003: audit log, application settings, and two new administrator columns.
-- For a database that already has migrations 001 and 002 (or a schema.sql from before this change). A database
-- created from the current schema.sql already has all of this, so do not run this file on it (it would stop with
-- "Table 'audit_log' already exists").
-- Run by the ADMIN account (inventory_app has no CREATE or ALTER privilege), once per database, by hand, BEFORE
-- running the application code that uses these tables. Take a backup first (see SETUP.md).
-- It creates two new tables and adds two columns to admins. No row is changed or removed, nothing is inserted,
-- and there are no DROP statements. Existing administrators keep working: they get token_version 0 and no display name.
--
-- Three statements follow (labelled STATEMENT 1 to 3 of 3). MySQL applies each on its own and cannot undo an
-- earlier one. If one fails, the earlier ones stay applied. NEVER run this whole file again after it has
-- partly succeeded: it would stop at statement 1 ("already exists") and never reach the rest. Run
-- `npm run db:check` to see exactly which parts exist, then follow "Recovery" in SETUP.md, which runs only the
-- missing statement(s). Never use the mysql client's --force option with this file.

SET NAMES utf8mb4;

-- STATEMENT 1 of 3: audit_log.
-- Append-only record of changes that no other table already records (products, customers, account, settings).
-- Orders and manual stock corrections are NOT copied here: order_status_history and stock_adjustments already
-- record them with who and when. The application only ever INSERTs into this table, in the same transaction
-- as the change it describes. details holds short non-sensitive JSON (for example which fields changed); it must
-- never contain passwords, hashes, tokens or contact details.
CREATE TABLE audit_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  occurred_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  admin_id    BIGINT UNSIGNED NOT NULL COMMENT 'the administrator who made the change',
  event_type  ENUM(
                'PRODUCT_CREATED','PRODUCT_UPDATED','PRODUCT_ACTIVATED','PRODUCT_DEACTIVATED',
                'CUSTOMER_CREATED','CUSTOMER_UPDATED','CUSTOMER_ACTIVATED','CUSTOMER_DEACTIVATED',
                'ACCOUNT_PROFILE_UPDATED','ACCOUNT_PASSWORD_CHANGED','SETTINGS_UPDATED'
              ) NOT NULL,
  entity_type ENUM('PRODUCT','CUSTOMER','ACCOUNT','SETTINGS') NOT NULL,
  entity_id   BIGINT UNSIGNED NULL COMMENT 'id of the product, customer or administrator, or NULL for settings',
  details     JSON            NULL COMMENT 'short non-sensitive facts only, such as changed field names',
  PRIMARY KEY (id),
  KEY idx_audit_log_occurred (occurred_at, id),
  KEY idx_audit_log_admin (admin_id),
  KEY idx_audit_log_entity (entity_type, entity_id),
  CONSTRAINT fk_audit_log_admin FOREIGN KEY (admin_id) REFERENCES admins (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- STATEMENT 2 of 3: app_settings.
-- Application preferences, one row per setting. No rows are inserted here: a setting with no row uses its
-- built-in default in the application (low_stock_threshold defaults to 5). Values are checked by the application.
CREATE TABLE app_settings (
  setting_key         VARCHAR(64)     NOT NULL,
  setting_value       VARCHAR(255)    NOT NULL,
  updated_by_admin_id BIGINT UNSIGNED NULL,
  updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key),
  CONSTRAINT fk_app_settings_admin FOREIGN KEY (updated_by_admin_id) REFERENCES admins (id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- STATEMENT 3 of 3: the two new admins columns.
-- display_name: optional name shown in the app. token_version: raised on every password change; a login token
-- only works while its version matches. A token issued before this migration has no version and counts as 0,
-- which is what every existing administrator starts with, so nobody is signed out by this migration.
-- One ALTER, so MySQL adds both columns or neither.
ALTER TABLE admins
  ADD COLUMN display_name  VARCHAR(100) NULL
    COMMENT 'optional name shown in the app' AFTER email,
  ADD COLUMN token_version INT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'raised on every password change to invalidate older login tokens' AFTER is_active;
