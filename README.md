# Inventory & Order Management System

Full-stack app: React (Vite) frontend, Express API, MySQL database. JavaScript only.

## Structure
- `server/` Express API (config, middleware, routes, validation, services, repositories, tests, database schema and scripts)
- `client/` React + Vite app (pages, components, API utilities, tests)
- `docs/` Design notes: how authentication works (`docs/AUTHENTICATION.md`)

## Setup
1. `cd server && npm install`, `cd client && npm install`
2. Set up MySQL by following [server/database/SETUP.md](server/database/SETUP.md). It uses two databases
   (`inventory_dev`, `inventory_test`) and a limited `inventory_app` account.
3. Copy `.env.example` to `server/.env` and `.env.test.example` to `server/.env.test`, then fill in real
   values locally (never commit them).

## Running the app locally
Use two terminals, both from the project folder:
1. `cd server` then `npm run dev` (API on port 5000)
2. `cd client` then `npm run dev` (web app on port 5173)

Open **http://localhost:5173** (not 127.0.0.1: the server only accepts that exact address).
An administrator must already exist in `inventory_dev` (`npm run admin:create` in `server/`).
Leave `NODE_ENV` unset in your terminal (unset means development). The API refuses to start if it is set to
`test` or any value other than `development` / `production`.

Pages have their own URLs, so a refresh keeps you on the same page: `/` (Dashboard), `/inventory` and `/customers`.
Any other path opens the Dashboard. Without a valid session every URL shows the sign-in page, and you return to the
page you asked for after signing in. Search text, filters and page number are not stored in the URL, so a refresh
resets them. A production host must serve `index.html` for these paths (the Vite dev and preview servers already do).

## Status

**Implemented**
- Administrator login, session check on page load (`GET /api/auth/me`) and logout, using an HttpOnly cookie.
- Inventory page: product list with search (SKU or name), status filter, sorting and pagination.
- Add Product: an inline form that creates a product through `POST /api/products`.
- Edit Product: an inline, pre-filled form (SKU, name, price) that sends only the changed fields through
  `PATCH /api/products/:id`. Inactive products can be edited too.
- Deactivate / Reactivate: a soft delete that flips `is_active`. Nothing is removed; deactivating asks for confirmation.
- Stock corrections: an "Adjust stock" form takes a signed change and a required reason, previews the result and
  refuses to go below 0. Each correction is saved in the `stock_adjustments` history table in the same database
  transaction as the stock change. Inactive products can be corrected too.
- Stock history: a "View stock history" action on every row opens a read-only, paginated table of that product's
  corrections (date and time, signed change, reason, administrator ID), newest first, with loading, empty and error states.
- Customers page: a table with search (name, email or phone), a status filter, sortable columns and pagination;
  an inline form to add and edit customers (name, email, optional phone and address); and Deactivate / Reactivate
  with a confirmation before deactivating. Customers are never deleted. Uses the existing `customers` table: no
  schema change or migration was needed.

**Not implemented yet**
- Deleting products (by design products are only deactivated).
- Orders (the sidebar entry is a disabled placeholder), reports, and a useful dashboard. Activity and Settings are placeholders too.

**Database change to apply.** Stock corrections need the `stock_adjustments` table. A database created from the
current `server/database/schema.sql` already has it. An existing database needs
`server/database/migrations/001_add_stock_adjustments.sql`, run once by the admin account (see
[SETUP.md](server/database/SETUP.md)). Until then the stock endpoint answers `500`; everything else keeps working.
`npm run db:check` lists the table as missing.

**Verification status.** The server and client have unit tests that use mocks and need no database. One
server integration suite covers authentication against a real MySQL test database. The product list, create,
edit, deactivate / reactivate, stock-adjustment and customer endpoints have no database-backed tests yet; the SQL (including
the row lock used for stock corrections) has not been run against MySQL by the automated tests. The same is true of
the stock-history and customer endpoints. This README does not record test results; run the commands below.

## API

All routes are under `/api`. Errors are JSON such as `{ "error": "..." }` and never include SQL or stack traces.

**Authentication** (see [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md))
- `POST /api/auth/login` with `{ email, password }` sets the session cookie. `POST /api/auth/logout` clears it.
  `GET /api/auth/me` returns `{ admin: { id, email } }` for a valid session, otherwise `401`.

**Products.** Every `/api/products` route needs the session cookie (`401 { "error": "Authentication required" }`
without it). Requests that change data must come from the frontend origin (`CLIENT_ORIGIN`), otherwise `403`.

`GET /api/products` query parameters (all optional; anything invalid returns `400 { "error": "Invalid request", "fields": [...] }`):

| Parameter | Values | Default |
|---|---|---|
| `q` | text, up to 100 characters; matches SKU or name (contains, case-insensitive per the column collation) | empty |
| `status` | `active`, `inactive`, `all` | `active` |
| `page` | whole number from 1 | `1` |
| `pageSize` | whole number 1–100 | `25` |
| `sort` | `sku`, `name`, `price`, `stockQuantity`, `updatedAt` | `name` |
| `order` | `asc`, `desc` | `asc` |

Response `200`: `{ items, page, pageSize, total, totalPages }`. Each item is
`{ id, sku, name, price, stockQuantity, isActive, createdAt, updatedAt }`. `price` is text such as `"19.99"`
(never a floating-point number). Ties in the sort are broken by `id`, so pages are stable. A page past the end
returns an empty `items` list.

`POST /api/products` body, as JSON (up to 10 KB):

| Field | Rule |
|---|---|
| `sku` | required; trimmed; 1–64 characters; ASCII letters, digits and `- _ . /` only (no spaces); letter case is kept |
| `name` | required; trimmed; 1–255 characters; no control characters |
| `price` | required; **text** such as `"19.99"`; up to 8 digits before and 2 after the decimal point; no sign, exponent, comma or currency symbol |
| `stockQuantity` | optional whole number 0–4,294,967,295; omitted (or `""`) means `0` |

Any other property (for example `id`, `isActive`, `createdAt`) is rejected. New products are always active.
Responses: `201 { "product": { ... } }` on success; `400` with `fields` naming each invalid property;
`409 { "error": "A product with this SKU already exists", "fields": ["sku"] }` for a duplicate SKU (the
database's unique key decides, and comparison follows the column collation, `utf8mb4_0900_ai_ci` in the
schema file, which ignores letter case and accents);
`413` if the body is too large.

The routes below use `:id`, a positive whole number (anything else is `400 { "error": "Invalid request", "fields": ["id"] }`).
An id that does not exist returns `404 { "error": "Product not found" }`. They need the session cookie and the
frontend origin like every other write, and they never return SQL or stack traces.

`PATCH /api/products/:id` edits a product. Body: any of `sku`, `name`, `price`, with the same rules as create.
At least one is required, and only the fields sent are changed. `stockQuantity`, `isActive`, `id` and any other
property are rejected with `400` (stock and status have their own routes). Works on inactive products.
Responses: `200 { "product": { ... } }`; `400`; `404`; `409` for a duplicate SKU, as above.
Changing a price does not change past orders: `order_items.unit_price` stores the price at the time of ordering.

`POST /api/products/:id/deactivate` and `POST /api/products/:id/reactivate` set `is_active` to 0 or 1 (no body needed).
Nothing is deleted. Repeating a call is harmless. Response: `200 { "product": { ... } }`.

`POST /api/products/:id/stock-adjustments` corrects stock. Body:

| Field | Rule |
|---|---|
| `delta` | required; a JSON whole number, not 0, between -2,147,483,647 and 2,147,483,647. Positive adds stock, negative removes it |
| `reason` | required; trimmed; 1–255 characters; no control characters |

Any other property (for example `stockQuantity`, `adminId`) is rejected. The administrator recorded in the history
is always the one signed in, never a value from the request. In one database transaction the server locks the product
row, checks the result, updates `stock_quantity` and inserts a `stock_adjustments` row; if any step fails, nothing is saved.
Works on inactive products. Responses: `201 { "product": { ... }, "adjustment": { id, productId, quantityDelta, reason, adminId, createdAt } }`;
`400`; `404`; `409 { "error": "...", "fields": ["delta"], "currentStock": 10 }` when the result would be below 0 or above
4,294,967,295 (nothing is changed).

`GET /api/products/:id/stock-adjustments` returns a product's stock history. It is read-only (nothing is written), needs
the session cookie like every `/api/products` route (`401` without it), and works for inactive products. Query parameters
(optional; anything invalid returns `400 { "error": "Invalid request", "fields": [...] }`):

| Parameter | Values | Default |
|---|---|---|
| `page` | whole number from 1 | `1` |
| `pageSize` | whole number 1–100 | `10` |

Response `200`: `{ items, page, pageSize, total, totalPages }`, newest first (ties broken by id, so pages are stable). Each item is
`{ id, productId, quantityDelta, reason, adminId, createdAt }`. `adminId` is the numeric ID of the administrator who made the
correction; no email or other personal data is returned. A product with no corrections returns `200` with an empty `items`
list and `total` 0; an unknown product returns `404 { "error": "Product not found" }`; an invalid `:id` returns
`400` with `fields: ["id"]`. A page past the end returns an empty `items` list.

**Customers.** Every `/api/customers` route needs the session cookie (`401` without it), and requests that change
data must come from the frontend origin (`403` otherwise), exactly like the product routes. Responses are never cached
(`Cache-Control: no-store`) and never include SQL or stack traces. Customers are never deleted: there is no `DELETE` route,
and the database keeps orders pointing at their customer.

`GET /api/customers` query parameters (all optional; anything invalid returns `400 { "error": "Invalid request", "fields": [...] }`):

| Parameter | Values | Default |
|---|---|---|
| `q` | text, up to 100 characters; matches name, email or phone (contains, case-insensitive per the column collation) | empty |
| `status` | `active`, `inactive`, `all` | `active` |
| `page` | whole number from 1 | `1` |
| `pageSize` | whole number 1–100 | `25` |
| `sort` | `name`, `email`, `createdAt`, `updatedAt` | `name` |
| `order` | `asc`, `desc` | `asc` |

Response `200`: `{ items, page, pageSize, total, totalPages }`. Each item is
`{ id, name, email, phone, address, isActive, createdAt, updatedAt }`; `phone` and `address` are `null` when not set.
Ties in the sort are broken by `id`, so pages are stable.

`POST /api/customers` body, as JSON (up to 10 KB). The limits come from the `customers` table:

| Field | Rule |
|---|---|
| `name` | required; trimmed; 1–255 characters; no control characters |
| `email` | required; trimmed and lower-cased; a valid email address, up to 255 characters; must be unique |
| `phone` | optional; digits and `+ ( ) - .` or spaces only, at least 3 digits, up to 32 characters; `""` or `null` means none |
| `address` | optional; up to 500 characters on one line; `""` or `null` means none |

Any other property (for example `id`, `isActive`) is rejected, and new customers are always active.
Responses: `201 { "customer": { ... } }`; `400` with `fields` naming each invalid property;
`409 { "error": "A customer with this email already exists", "fields": ["email"] }` for a duplicate email
(the database's unique key decides; comparison ignores letter case and accents); `413` if the body is too large.

`PATCH /api/customers/:id` edits a customer: any of `name`, `email`, `phone`, `address` with the rules above (at least
one; only the fields sent are changed; `""` or `null` clears `phone` or `address`). `isActive` and any other property are
rejected with `400`. Works on inactive customers. Responses: `200 { "customer": { ... } }`; `400`; `404`
`{ "error": "Customer not found" }`; `409` for a duplicate email. An invalid `:id` returns `400` with `fields: ["id"]`.

`POST /api/customers/:id/deactivate` and `POST /api/customers/:id/reactivate` set `is_active` to 0 or 1 (no body needed).
Nothing is deleted, and repeating a call is harmless. Response: `200 { "customer": { ... } }` (or `400` / `404` as above).

## Testing

Run these from `server/` or `client/`. **Know which commands write to a database before you run them.**

| Command | What it does | Database effect |
|---|---|---|
| `server`: `npm test` or `npm run test:unit` | Unit tests with mocks | None. No connection is made. |
| `server`: `npm run test:integration` | Authentication tests against real MySQL | **WRITES.** Deletes **all rows** from the seven tables in `inventory_test` before and after the run, and creates a temporary test admin. Refuses to run unless the connected database is exactly `inventory_test`. Never touches `inventory_dev`. |
| `server`: `npm run db:check` / `npm run db:check:test` | Connects and lists tables | Read-only (dev / test database). |
| `server`: `npm run admin:create` | Creates the administrator | **WRITES** one row to `inventory_dev` after a typed confirmation. |
| `client`: `npm test` | Component and API tests with a fake `fetch` | None, and no server is needed. |
| `client`: `npm run build` | Production build into `client/dist` | None. |

`npm test` deliberately skips `tests/integration/`. Do not reorder the flags of the `test:integration` script:
the path must come first.
