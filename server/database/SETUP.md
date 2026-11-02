# Local Database Setup (MySQL 8)

You run each step yourself and decide when. Nothing in this guide is run for you.
Never paste a password into chat, a file in git, or a command-line argument. Every `-p` below makes the MySQL client ask
for the password at a hidden prompt.

The commands are for **Windows PowerShell** unless a step says otherwise. They use two variables; set them once per
window and change the paths if MySQL lives somewhere else:

```powershell
$mysql     = "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe"
$mysqldump = "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe"
```

## How to read this guide: read-only or writes?

Every step and command that touches a database is marked:

| Mark | Meaning |
|---|---|
| **READ-ONLY** | Only reads. Changes no data and no structure. Safe to repeat. |
| **WRITES (admin)** | Changes a database. Run it with the MySQL admin account, on the database named in the step, and only once unless the step says otherwise. Take a backup first. |
| **WRITES (app)** | Changes rows through the application's limited account. |

## How to run a SQL file (the interactive procedure)

Schema, migration and seed files are run **inside the interactive MySQL client**, using its `SOURCE` command. Do not pass
`SOURCE` on the PowerShell command line, and do not use `<` redirection in PowerShell (it is not supported). The same four
steps are used everywhere below:

1. Open the client as the admin account, **without** naming a database. It asks for the admin password at a hidden prompt:
   ```powershell
   & $mysql -u root -p
   ```
2. Select the target database: `USE inventory_dev;` (or `USE inventory_test;`).
3. **Verify where you are** before running anything. The answer must be exactly the database you intend to change:
   ```sql
   SELECT DATABASE();
   ```
4. Run the file with `SOURCE path/to/file.sql;`, using the full path with **forward slashes** (the examples assume the
   project is in `C:/dev/inventory-order-management`; change that part if yours is elsewhere; the trailing semicolon is
   optional for `SOURCE`). Watch the result of every statement: each should answer `Query OK`. Any `ERROR` line means stop,
   copy the message and do not run the file again. Leave with `exit`.

If `SELECT DATABASE();` shows anything other than the database you intended, type `exit` and start again. Every block
below repeats these steps for its own file so it can be followed on its own.

## What the database looks like

The schema has **nine tables**: `admins`, `products`, `customers`, `orders`, `order_items`, `order_status_history`,
`stock_adjustments`, `audit_log` and `app_settings`. Two databases are used:

| Database | Used for |
|---|---|
| `inventory_dev` | Running the app by hand (data you care about) |
| `inventory_test` | The integration tests only. **All nine tables in it are emptied before every integration test and after the run.** |

| Migration | File | Adds | Needed for |
|---|---|---|---|
| 001 | `001_add_stock_adjustments.sql` | The `stock_adjustments` table | Stock corrections |
| 002 | `002_add_order_stock_movements.sql` | `order_id` and `movement_type` on `stock_adjustments`, a unique key and a foreign key to `orders` | Confirming and cancelling orders |
| 003 | `003_add_audit_log_and_settings.sql` | `audit_log`, `app_settings`, `admins.display_name`, `admins.token_version` | Activity, Settings, password change and session invalidation |

**A database created from the current `schema.sql` already contains all of this. Do not run any migration on it.**
Migrations are only for an older database, and must be applied **in the order 001, 002, 003, each once**.
An older database may already have some of them: `npm run db:check` (read-only) tells you which parts are missing. Apply
only the missing ones, and still in that order (never 003 before 002, or 002 before 001).

## The two kinds of account

| Account | Used for | Who uses it |
|---|---|---|
| Admin (e.g. `root`) | Creating databases, users, tables; migrations; backups | You, in the `mysql` client only |
| `inventory_app` | Running the application and the tests | The Node app (limited privileges) |

`inventory_app` gets only `SELECT, INSERT, UPDATE, DELETE` on the two databases.
It has no `CREATE`, `ALTER`, `DROP`, `GRANT OPTION` or global privileges, so the app cannot change the
schema or drop anything. `SELECT ... FOR UPDATE` (used for safe order handling) works with these privileges.
Note that the same account can write to both databases: the separation between development and test data is enforced by
the application's safety checks, not by MySQL permissions.

## Step 1: Create the databases and the app user (WRITES, admin)

Optional: stop the client saving what you type to its history file:
```powershell
$env:MYSQL_HISTFILE = "NUL"
```

Open the client. It asks for the admin password at a hidden prompt:
```powershell
& $mysql -u root -p
```

Then, inside the client:
```sql
CREATE DATABASE inventory_dev  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE inventory_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- Type your chosen password in place of the text between the quotes. Do not share it.
CREATE USER 'inventory_app'@'localhost' IDENTIFIED BY 'TYPE_A_STRONG_PASSWORD_HERE';

GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_dev.*  TO 'inventory_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_test.* TO 'inventory_app'@'localhost';
```
What this does: creates two empty databases, creates one local-only user, and gives it data-only access to those two databases.

Check the privileges (**READ-ONLY**):
```sql
SHOW GRANTS FOR 'inventory_app'@'localhost';
```
You should see only the two `GRANT SELECT, INSERT, UPDATE, DELETE` lines plus `USAGE`.

## Step 2: Apply the schema to a NEW, empty database (WRITES, admin)

Run once per database, following the interactive procedure above. First `inventory_dev`:
```powershell
& $mysql -u root -p
```
```sql
USE inventory_dev;
SELECT DATABASE();
SOURCE C:/dev/inventory-order-management/server/database/schema.sql;
```
`SELECT DATABASE();` must show `inventory_dev` before you run `SOURCE`. Then repeat the three statements with
`USE inventory_test;`, where `SELECT DATABASE();` must show `inventory_test`.

This creates nine empty tables with their keys and constraints. The file has no `DROP` statements; if a table already
exists, it stops with an error instead of overwriting.

## Step 3: Upgrading an older database with migrations (WRITES, admin)

Skip this whole step for a database created from the current `schema.sql`.

General rules for every migration:
1. **READ-ONLY** first: from `server/`, run `npm run db:check` (for `inventory_dev`) or `npm run db:check:test` (for
   `inventory_test`) and read which migration lines say `MISSING`.
2. Back up the database (see "Backups and restore" below).
3. Apply the migration once, using the interactive procedure: `USE` the database, check that `SELECT DATABASE();` shows
   the right one, then `SOURCE` the file.
4. **READ-ONLY** again: run the same `db:check` command and confirm the migration is "fully applied".
5. If anything prints `ERROR`, stop. Do not run the file again. Copy the message.

### Migration 001: stock corrections

Adds only the `stock_adjustments` table; it changes no existing table or row and has no `DROP`.
```powershell
& $mysql -u root -p
```
```sql
USE inventory_dev;
SELECT DATABASE();
SOURCE C:/dev/inventory-order-management/server/database/migrations/001_add_stock_adjustments.sql;
```
`SELECT DATABASE();` must show the database you meant before you run `SOURCE`. To apply it to the test database, run the
three statements again with `USE inventory_test;`. Running it on a database that already has the table stops with
`already exists` and changes nothing.

### Migration 002: order confirmation and cancellation (after 001)

Confirming an order, and cancelling a `CONFIRMED` order (which puts its stock back), record their stock movements in
`stock_adjustments`, which needs two new columns (`order_id` and `movement_type`). Run it **after** 001 and **before**
confirming any order:
```powershell
& $mysql -u root -p
```
```sql
USE inventory_dev;
SELECT DATABASE();
SOURCE C:/dev/inventory-order-management/server/database/migrations/002_add_order_stock_movements.sql;
```
`SELECT DATABASE();` must show the database you meant before you run `SOURCE`. To apply it to the test database, run the
three statements again with `USE inventory_test;`.

It is one `ALTER TABLE`, so MySQL adds everything or nothing. Existing rows are kept and become `MANUAL` movements. It has
no `DROP`. On a database that already has the columns it stops with `Duplicate column name` and changes nothing. Without
it, creating and viewing orders and cancelling a `PENDING` order still work, but confirming an order and cancelling a
`CONFIRMED` order fail with an error (nothing is saved).

### Migration 003: activity log, settings and sessions (after 001 and 002)

The Activity page, the Settings page and password changes need two new tables (`audit_log`, `app_settings`) and two new
columns on `admins` (`display_name`, `token_version`). Run it **after** 001 and 002 and **before** running the application
code that uses them. The file has three statements (two `CREATE TABLE`, one `ALTER TABLE`). It inserts nothing, changes no
row and has no `DROP`. Existing administrators keep working (their `token_version` starts at 0).

**Never run the whole file a second time after it has partly succeeded.** MySQL cannot undo an earlier statement, and a
re-run stops at the first statement ("already exists") without reaching the missing ones. Use "Recovery" below instead.
Never use the `mysql` client's `--force` option with this file.

**Apply** (back up first), using the interactive procedure so you see the result of every statement:
```powershell
& $mysql -u root -p
```
```sql
USE inventory_dev;
SELECT DATABASE();
SOURCE C:/dev/inventory-order-management/server/database/migrations/003_add_audit_log_and_settings.sql;
```
`SELECT DATABASE();` must show the database you meant before you run `SOURCE`. To apply it to the test database, run the
three statements again with `USE inventory_test;`. Each of the three statements in the file should answer `Query OK`. Any
`ERROR` line: stop, copy it, and go to Recovery. Do not run the file again.

**Verify (READ-ONLY):** `npm run db:check` (or `npm run db:check:test` for `inventory_test`) must end with
`Migration 003 is fully applied.`

#### Recovery after an error or a partial migration 003

Migration 003 is three separate statements, and MySQL cannot undo an earlier one if a later one fails. So after any error,
or if you are not sure what happened:

1. **Stop. Do not run the whole file again**, and do not use `--force`.
2. Run `npm run db:check` (or `npm run db:check:test` for `inventory_test`; both are read-only) and read the lines for
   Migration 003. Never guess from the error alone.
3. Find the matching row below and do only what it says. Never `DROP` a table to "start again".

| `db:check` shows | What it means | What to do |
|---|---|---|
| `Migration 003 is fully applied` (for example after `ERROR 1050 ... already exists`) | The file was run twice; the second run stopped at statement 1 and changed nothing | Nothing to do |
| Every 003 line `MISSING`, `NOT applied` | The first statement failed, so nothing was created | Fix the cause named in the error. Only because `db:check` confirms that nothing was applied, the whole file may then be run once, using the interactive procedure |
| `audit_log` all `ok`; `app_settings` and `admins` lines `MISSING` | Statement 1 worked, statement 2 failed | Run **only statement 2**, then **only statement 3** (see below), checking `db:check` after each |
| `audit_log` and `app_settings` all `ok`; the two `admins` columns `MISSING` | Statements 1 and 2 worked, statement 3 failed | Run **only statement 3** |
| A table that exists but has some `MISSING` lines (a column, index or foreign key) | Something outside this file changed it | Stop. Do not fix it by hand and do not drop or recreate it. Keep the full `db:check` output and have it reviewed against `schema.sql` first |
| Any other mix (for example `admins` columns `ok` but `audit_log` `MISSING`) | Something was run out of order or by hand | Stop. Keep the full `db:check` output and have it reviewed before running anything |

To run **one statement** (only for the two rows that say "Run only statement"), open
`server/database/migrations/003_add_audit_log_and_settings.sql` in an editor. Copy **only the SQL**, not the `--` comment lines
above it (a comment line inside statement 1 contains a semicolon, so copying "down to the first `;`" would be wrong):

| Statement | Copy from the line | Down to and including the line |
|---|---|---|
| 1 (`audit_log`) | `CREATE TABLE audit_log (` | `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;` (the first one in the file) |
| 2 (`app_settings`) | `CREATE TABLE app_settings (` | `) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;` (the second one) |
| 3 (`admins` columns) | `ALTER TABLE admins` | `... AFTER is_active;` (the last line of the file) |

Then open the client **without** naming a database, run `USE <database>;`, run `SELECT DATABASE();` and check the answer, paste
the one statement, and wait for `Query OK`. Run the same `db:check` command again before doing anything else. If the state is
still unclear after that, stop: the backup you took before the migration is the fallback, but do not restore anything without
reviewing what it would overwrite (see "Restore").

## Step 4 (optional): Sample data, development only (WRITES, admin)

```powershell
& $mysql -u root -p
```
```sql
USE inventory_dev;
SELECT DATABASE();
SOURCE C:/dev/inventory-order-management/server/database/seed.sql;
```
`SELECT DATABASE();` must show `inventory_dev` before you run `SOURCE`.

This inserts 5 products and 3 customers. It contains no administrators or passwords. It has a guard that makes the script
fail if the selected database name ends in `_test`. Never seed `inventory_test`; tests create their own data. Running it
twice fails on the unique SKU/email keys instead of duplicating rows.

## Step 5: Configure the app (local files, git-ignored)

From the project root:
```powershell
Copy-Item .env.example      server\.env
Copy-Item .env.test.example server\.env.test
```
Open both files in your editor and replace the placeholder values (database password, `JWT_SECRET`). Use a different
`JWT_SECRET` of at least 32 random characters in each file; the example files show how to generate one. Never commit
these files and never paste their contents anywhere.
- `server/.env` must use `DB_NAME=inventory_dev`.
- `server/.env.test` must use `DB_NAME=inventory_test`.

The app refuses to start if a required variable is missing, if a test run points at any database other than
exactly `inventory_test`, or if a normal run points at a database whose name ends in `_test`. The API
(`npm run dev` / `npm start`) also refuses to start when `NODE_ENV` is `test` or anything other than
`development` / `production`; an unset `NODE_ENV` means `development`.

## Step 6: Verify the connection (READ-ONLY)

From `server/`:
```powershell
npm run db:check
```
Expected on success: `Connected to database: inventory_dev`, `All original tables are present.`, `Migration 002 is fully
applied.` and `Migration 003 is fully applied.` (A database that lacks a migration says `NOT applied`; the original-tables
line covers `stock_adjustments`, i.e. migration 001.) On failure it prints only a short error code, never credentials.

To check the test database, use the dedicated script. It switches to test mode for that one command only:
```powershell
npm run db:check:test
```

### Do not set `NODE_ENV` in your terminal
Setting `NODE_ENV=test` in a PowerShell/cmd/bash session **stays set for every later command in that window**
(this once caused `admin:create` to pick the test database). `admin:create` and the API now refuse to run
with it. Jest sets test mode by itself, and `db:check:test` does it per command, so you never need to set it
manually.

Check and restore development mode:
- PowerShell: `echo $env:NODE_ENV` shows the value (empty is correct). Clear it with `Remove-Item Env:NODE_ENV`.
- cmd: `echo %NODE_ENV%`, then `set NODE_ENV=`.
- Git Bash: `echo $NODE_ENV`, then `unset NODE_ENV`.
- Or simply open a new terminal window.

Anything else you set the same way (like `DB_NAME`) also persists; clear it too.

## Backups and restore

Keep backups **outside the repository** (the examples use `C:\dev\shelfsync-backups`; create that folder once). Backup files
contain your data, so never commit them.

### Back up (READ-ONLY for the database; writes one file)

Create a dated file. The command refuses to overwrite an existing file and asks for the admin password at a hidden prompt.
Change the database name (`inventory_dev` or `inventory_test`) in both places:
```powershell
New-Item -ItemType Directory -Force "C:\dev\shelfsync-backups" | Out-Null
$f = "C:\dev\shelfsync-backups\inventory_dev_$(Get-Date -Format yyyyMMdd-HHmmss).sql"; if (Test-Path -LiteralPath $f) { throw "Backup already exists: $f" } else { & $mysqldump -u root -p --single-transaction --routines --triggers --no-tablespaces --set-gtid-purged=OFF --result-file="$f" inventory_dev }
```
Check it in the same window. The size must be above 0 and the last line must start with `-- Dump completed`:
```powershell
(Get-Item -LiteralPath $f).Length
Get-Content -LiteralPath $f -Tail 1
```
Take a backup before every migration and before anything else that changes structure.

### Restore (WRITES, admin) - read this first

A dump made with the options above contains `DROP TABLE IF EXISTS` for each table. **Restoring OVERWRITES the target
database: every table in the backup file is dropped and recreated, and the data currently in those tables is permanently
lost.** Tables that are not in the backup file are left as they are, so restoring an older backup into a database that has
since been migrated gives a mixed, inconsistent schema. Only restore a backup into a database at the same schema version
(for example, a pre-migration backup is not a way to undo a migration in a database that is already migrated).

Follow these steps in order:
1. Decide whether you really need to overwrite. To only inspect or copy data out of a backup, restore it into a **new scratch
   database** instead (`CREATE DATABASE inventory_restore_check ...;` in the client, restore into it, look, then drop it
   yourself once you are sure).
2. **Take a fresh backup of the database you are about to overwrite**, and check it (size above 0, last line
   `-- Dump completed`), as described above. Do not continue without it.
3. Restore with the interactive procedure described at the top of this guide. Open the client **without** naming a
   database, then `USE` the target, run `SELECT DATABASE();`, check the answer, and only then run `SOURCE`. Use the full
   path of your backup file with forward slashes. If the backup came from `inventory_test`, use `USE inventory_test;` instead:

   ```powershell
   & $mysql -u root -p
   ```
   ```sql
   USE inventory_dev;
   SELECT DATABASE();
   SOURCE C:/dev/shelfsync-backups/NAME_OF_THE_BACKUP_FILE.sql;
   ```
   **`SELECT DATABASE();` must show the database you intend to overwrite, and it should be the database the backup came
   from. If it shows anything else, type `exit` and do not run `SOURCE`.** Watch every statement for `ERROR`; if one appears,
   stop and review before doing anything else.
4. **READ-ONLY:** run `npm run db:check` (or `npm run db:check:test`) and look at the data in the app.

The application account `inventory_app` cannot restore, because it has no `CREATE`, `DROP` or `ALTER` privilege.

## Which commands touch a database

Run from `server/`:

| Command | Database effect |
|---|---|
| `npm test`, `npm run test:unit` | **None.** Unit tests use mocks and never connect (the MySQL driver is replaced by a fake that refuses). `npm test` skips `tests/integration/`. |
| `npm run db:check`, `npm run db:check:test` | **READ-ONLY.** Connects and checks the tables, columns, indexes and foreign keys (`inventory_dev` / `inventory_test`). |
| `npm run test:integration` | **WRITES (app) to `inventory_test` only.** Before every test and after the run it empties all nine tables (`DELETE FROM`, in an order that respects the foreign keys) through `tests/helpers/resetDb.js`, and creates its own test data (administrators, customers, products, orders). |
| `npm run admin:create` | **WRITES (app) one row to `inventory_dev`** after you type `inventory_dev` to confirm. |
| `npm run dev`, `npm start` | The running API reads and writes `inventory_dev` as you use the app. |

The cleanup helper refuses to run unless `NODE_ENV=test`, the configured `DB_NAME` is exactly `inventory_test`,
and the server reports that the connected database is exactly `inventory_test`. Because every table in
`inventory_test` is emptied, never keep data there that you want to keep.

### Before running the integration tests

`inventory_test` must have the **full current schema**: either created from the current `schema.sql`, or upgraded with
migrations 001, 002 and 003. If it is behind, `npm run db:check:test` (READ-ONLY) says so, and the cleanup would fail on a
missing table. Check it first, then run `npm run test:integration` from `server/` in a terminal where `NODE_ENV` is not set.

## Administrator account

No admin is created by any SQL file. Run `npm run admin:create` from `server/` in a real terminal.
It only ever targets `inventory_dev`:
- It refuses to run if `NODE_ENV` is set to anything other than `development` (it never overrides it).
- It requires the config to come from `server/.env` with `DB_NAME` exactly `inventory_dev`.
- It checks the live database name with `SELECT DATABASE()` before any prompt.
- It shows the target and asks you to type `inventory_dev` to confirm.
- Then it asks for the email and a hidden password (typed twice, at least 12 characters) and stores only a bcrypt hash.

It refuses to add a second admin unless you pass `--allow-additional`.
