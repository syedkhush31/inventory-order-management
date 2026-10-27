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

What this does: creates six empty tables with their keys and constraints. The file has no `DROP` statements.
If a table already exists, it stops with an error instead of overwriting.

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
exactly `inventory_test`, or if a normal run points at a database whose name ends in `_test`.

## Step 5: Verify the connection

From `server/`:
```
npm run db:check
```
Expected on success: `Connected to database: inventory_dev` and `All expected tables are present.`
On failure it prints only a short error code, never credentials.

To check the test database, use the dedicated script. It switches to test mode for that one command only:
```
npm run db:check:test
```

### Do not set `NODE_ENV` in your terminal
Setting `NODE_ENV=test` in a PowerShell/cmd/bash session **stays set for every later command in that window**
(this once caused `admin:create` to pick the test database). Jest sets test mode by itself, and
`db:check:test` does it per command, so you never need to set it manually.

Check and restore development mode:
- PowerShell: `echo $env:NODE_ENV` shows the value (empty is correct). Clear it with `Remove-Item Env:NODE_ENV`.
- cmd: `echo %NODE_ENV%`, then `set NODE_ENV=`.
- Git Bash: `echo $NODE_ENV`, then `unset NODE_ENV`.
- Or simply open a new terminal window.

Anything else you set the same way (like `DB_NAME`) also persists; clear it too.

## Test cleanup

Tests will empty tables with `DELETE FROM` through `server/tests/helpers/resetDb.js`. It refuses to run unless
`NODE_ENV=test` and the server reports the connected database is exactly `inventory_test`.

## Administrator account

No admin is created by any SQL file. Run `npm run admin:create` from `server/` in a real terminal.
It only ever targets `inventory_dev`:
- It refuses to run if `NODE_ENV` is set to anything other than `development` (it never overrides it).
- It requires the config to come from `server/.env` with `DB_NAME` exactly `inventory_dev`.
- It checks the live database name with `SELECT DATABASE()` before any prompt.
- It shows the target and asks you to type `inventory_dev` to confirm.
- Then it asks for the email and a hidden password (typed twice) and stores only a bcrypt hash.

It refuses to add a second admin unless you pass `--allow-additional`.
