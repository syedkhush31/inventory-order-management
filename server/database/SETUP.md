# Local Database Setup (MySQL 8)

Nothing in this guide has been run by Claude. You run each step yourself and decide when.
Never paste a password into chat, a file in git, or a command-line argument.

## The two kinds of account

| Account | Used for | Who uses it |
|---|---|---|
| Admin (e.g. `root`) | Creating databases, users, tables | You, in the `mysql` client only |
| `inventory_app` | Running the application and tests | The Node app (limited privileges) |

`inventory_app` gets only `SELECT, INSERT, UPDATE, DELETE` on the two databases.
It has no `CREATE`, `ALTER`, `DROP`, `GRANT OPTION` or global privileges, so the app cannot change the
schema or drop anything. `SELECT ... FOR UPDATE` (used for safe order handling) works with these privileges.

## Step 1: Create the databases and the app user (admin account)

Optional: stop the client saving what you type to its history file (PowerShell):
```powershell
$env:MYSQL_HISTFILE = "NUL"
```

Open the client. It asks for the admin password at a hidden prompt:
```
mysql -u root -p
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

Check the privileges (this changes nothing):
```sql
SHOW GRANTS FOR 'inventory_app'@'localhost';
```
You should see only the two `GRANT SELECT, INSERT, UPDATE, DELETE` lines plus `USAGE`.

## Step 2: Apply the schema (admin account)

Run from the project root. Each command prompts for the admin password:
```
mysql -u root -p inventory_dev  < server/database/schema.sql
mysql -u root -p inventory_test < server/database/schema.sql
```
(In Windows PowerShell, `<` redirection is not supported. Use Git Bash, `cmd`, or inside the client run
`USE inventory_dev; SOURCE server/database/schema.sql;`.)

What this does: creates nine empty tables with their keys and constraints. The file has no `DROP` statements.
If a table already exists, it stops with an error instead of overwriting.

### Upgrading a database that was created before stock corrections existed

`schema.sql` now also creates `stock_adjustments`. A database created from an older copy of the file does not have it
(`npm run db:check` will list it as missing). Add only that table, once per database, with the admin account:
```
mysql -u root -p inventory_dev  < server/database/migrations/001_add_stock_adjustments.sql
mysql -u root -p inventory_test < server/database/migrations/001_add_stock_adjustments.sql
```
(Same PowerShell note as above: use Git Bash or `cmd`, or `SOURCE` the file inside the client.)
The file only creates a new table; it changes no existing table or row and has no `DROP`. Do not run it on a database
you just created from the current `schema.sql`: that already has the table and the script will stop with an error.

### Upgrading a database for order confirmation and cancellation (migration 002)

Confirming an order, and cancelling a CONFIRMED order (which puts its stock back), record their stock movements in
`stock_adjustments`, which needs two new columns (`order_id` and `movement_type`). A database created from an older `schema.sql` does not have them
(`npm run db:check` will report them as missing). Run once per database, with the admin account, **after** migration 001 and
**before** confirming any order:
```
mysql -u root -p inventory_dev  < server/database/migrations/002_add_order_stock_movements.sql
mysql -u root -p inventory_test < server/database/migrations/002_add_order_stock_movements.sql
```
(Same PowerShell note as above.) The file only adds columns, a unique key and a foreign key to `stock_adjustments`;
existing rows are kept and become `MANUAL` movements. It has no `DROP`. Do not run it on a database you just created from the
current `schema.sql`: that already has the columns and the script will stop with an error. Without it, creating and
viewing orders and cancelling a PENDING order still work, but confirming an order and cancelling a CONFIRMED order fail
with an error (nothing is saved).

### Upgrading a database for the activity log and settings (migration 003)

The Activity page, the Settings page and password changes need two new tables (`audit_log`, `app_settings`) and
two new columns on `admins` (`display_name`, `token_version`). A database created from an older `schema.sql` does not
have them. Run the migration once, with the admin account, **after** migrations 001 and 002 and **before** running the
application code that uses them, on `inventory_dev` only for now. The file has three statements (two `CREATE TABLE`, one
`ALTER TABLE`). It inserts nothing, changes no row and has no `DROP`. Existing administrators keep working (their
`token_version` starts at 0). Do not run it on a database you just created from the current `schema.sql`.

**Never run the whole file a second time after it has partly succeeded.** MySQL cannot undo an earlier statement, and a
re-run stops at the first statement ("already exists") without reaching the missing ones. Use "Recovery" below instead.
Never use the `mysql` client's `--force` option with this file.

**Do not apply migration 003 to `inventory_test` yet.** `tests/helpers/resetDb.js` empties tables in a fixed order and does not
know about `audit_log`; once that table exists, its link to `admins` would stop the integration test cleanup from removing the
test administrator. The helper will be updated together with the tests for these features, and this note will be changed then.

All commands below are for PowerShell, run from the project root unless stated. Nothing here is run for you.

**1. Check the starting point** (from `server/`; read-only):
```
npm run db:check
```
Expected before the migration: the 002 lines all `ok` and `Migration 002 is fully applied.`, every 003 line `MISSING`, and
`Migration 003 is NOT applied.` If you see `PARTIAL MIGRATION`, stop and go to Recovery.

**2. Back up** (one line; the file name gets the current date and time, and the command refuses to overwrite an existing file):
```
$f = "C:\dev\shelfsync-backups\inventory_dev_pre-migration-003_$(Get-Date -Format yyyyMMdd-HHmmss).sql"; if (Test-Path -LiteralPath $f) { throw "Backup already exists: $f" } else { & "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe" -u root -p --single-transaction --routines --triggers --no-tablespaces --set-gtid-purged=OFF --result-file="$f" inventory_dev }
```
It asks for the admin password at a hidden prompt. In the same window, check it: `(Get-Item -LiteralPath $f).Length` must be above 0
and `Get-Content -LiteralPath $f -Tail 1` must start with `-- Dump completed`.

**3. Apply** with `mysql.exe` and `SOURCE` (use forward slashes in the `SOURCE` path). Interactive form, recommended
because it shows the result of every statement:
```
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p
```
then, inside the client:
```
USE inventory_dev;
SELECT DATABASE();
SOURCE C:/dev/inventory-order-management/server/database/migrations/003_add_audit_log_and_settings.sql
```
`SELECT DATABASE();` must show `inventory_dev`. Each statement should answer `Query OK`. Any `ERROR` line: stop, copy it, and go
to Recovery. Do not run the file again. One-line form (prints nothing when it succeeds):
```
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p inventory_dev -e "source C:/dev/inventory-order-management/server/database/migrations/003_add_audit_log_and_settings.sql"
```

**4. Verify** (from `server/`; read-only): `npm run db:check` must end with `Migration 003 is fully applied.`

#### Recovery after an error or a partial migration 003

First run `npm run db:check` (read-only) and read the lines for Migration 003. Never guess from the error alone.

| `db:check` shows | What it means | What to do |
|---|---|---|
| Every 003 line `MISSING`, `NOT applied` | The first statement failed, so nothing changed | Fix the cause named in the error, then run the whole file once (step 3) |
| `audit_log` all `ok`; `app_settings` and `admins` lines `MISSING` | Statement 1 worked, statement 2 failed | Run **only statement 2**, then **only statement 3** (see below), checking `db:check` after each |
| `audit_log` and `app_settings` all `ok`; the two `admins` columns `MISSING` | Statements 1 and 2 worked, statement 3 failed | Run **only statement 3** |
| A table that exists but has some `MISSING` lines (a column, index or foreign key) | Something outside this file changed it | Stop. Do not fix by hand. Send me the full `db:check` output. The new tables are empty, so recreating one is possible, but only after review |
| Any other mix (for example `admins` columns `ok` but `audit_log` `MISSING`) | Something was run out of order or by hand | Stop and send me the full `db:check` output |
| `Migration 003 is fully applied` after an error such as `ERROR 1050 ... already exists` | The file was run twice; the second run stopped at statement 1 and changed nothing | Nothing to do |

To run **one statement**: open `server/database/migrations/003_add_audit_log_and_settings.sql` in an editor and copy from its
`-- STATEMENT n of 3` label down to the `;` that ends it. Open the client as in step 3, run `USE inventory_dev;` and
`SELECT DATABASE();`, paste the statement, and run `npm run db:check` again. If the state is still unclear, the
backup from step 2 is the fallback: ask before restoring anything.

## Step 3 (optional): Sample data, development only (admin account)

```
mysql -u root -p inventory_dev < server/database/seed.sql
```
This inserts 5 products and 3 customers. It contains no administrators or passwords. It has a guard that
makes the script fail if the selected database name ends in `_test`. Never seed `inventory_test`;
tests create their own data.

## Step 4: Configure the app (local files, git-ignored)

```
copy .env.example      server\.env
copy .env.test.example server\.env.test
```
Open both files in your editor and replace `your_database_password` with the password you chose.
- `server/.env` must use `DB_NAME=inventory_dev`.
- `server/.env.test` must use `DB_NAME=inventory_test`.

The app refuses to start if a required variable is missing, if a test run points at any database other than
exactly `inventory_test`, or if a normal run points at a database whose name ends in `_test`. The API
(`npm run dev` / `npm start`) also refuses to start when `NODE_ENV` is `test` or anything other than
`development` / `production`; an unset `NODE_ENV` means `development`.

## Step 5: Verify the connection

From `server/`:
```
npm run db:check
```
Expected on success: `Connected to database: inventory_dev`, `All original tables are present.`, and `Migration 002 is fully applied.`
and `Migration 003 is fully applied.` (once migration 003 has been applied; before that it says `NOT applied`).
On failure it prints only a short error code, never credentials.

To check the test database, use the dedicated script. It switches to test mode for that one command only:
```
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

## Which commands touch a database

Run from `server/`:

| Command | Database effect |
|---|---|
| `npm test`, `npm run test:unit` | None. Unit tests use mocks and never connect. `npm test` skips `tests/integration/`. |
| `npm run test:integration` | **Writes to `inventory_test` only.** Before and after the run it empties every table (`DELETE FROM`, in an order that respects the foreign keys) through `tests/helpers/resetDb.js`, and creates a temporary test admin. |
| `npm run db:check`, `npm run db:check:test` | Read-only: connects and checks the tables, columns, indexes and foreign keys (`inventory_dev` / `inventory_test`). |
| `npm run admin:create` | **Writes one row to `inventory_dev`** after you type `inventory_dev` to confirm. |

The cleanup helper refuses to run unless `NODE_ENV=test`, the configured `DB_NAME` is exactly `inventory_test`,
and the server reports that the connected database is exactly `inventory_test`. Because every table in
`inventory_test` is emptied, never keep data there that you want to keep.

## Administrator account

No admin is created by any SQL file. Run `npm run admin:create` from `server/` in a real terminal.
It only ever targets `inventory_dev`:
- It refuses to run if `NODE_ENV` is set to anything other than `development` (it never overrides it).
- It requires the config to come from `server/.env` with `DB_NAME` exactly `inventory_dev`.
- It checks the live database name with `SELECT DATABASE()` before any prompt.
- It shows the target and asks you to type `inventory_dev` to confirm.
- Then it asks for the email and a hidden password (typed twice) and stores only a bcrypt hash.

It refuses to add a second admin unless you pass `--allow-additional`.
