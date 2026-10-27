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

## Status

**Implemented**
- Administrator login, session check on page load (`GET /api/auth/me`) and logout, using an HttpOnly cookie.
- Inventory page: product list with search (SKU or name), status filter, sorting and pagination.
- Add Product: an inline form that creates a product through `POST /api/products`.

**Not implemented yet**
- Editing, deactivating or deleting products; stock adjustments and stock-movement history.
- Customers and Orders (their sidebar entries are disabled placeholders), reports, and a useful dashboard.

**Verification status.** The server and client have unit tests that use mocks and need no database. One
server integration suite covers authentication against a real MySQL test database. The product list and
create endpoints have no database-backed tests yet; their behaviour against MySQL has so far been checked
only by using the app in a browser. This README does not record test results; run the commands below.

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

## Testing

Run these from `server/` or `client/`. **Know which commands write to a database before you run them.**

| Command | What it does | Database effect |
|---|---|---|
| `server`: `npm test` or `npm run test:unit` | Unit tests with mocks | None. No connection is made. |
| `server`: `npm run test:integration` | Authentication tests against real MySQL | **WRITES.** Deletes **all rows** from the six tables in `inventory_test` before and after the run, and creates a temporary test admin. Refuses to run unless the connected database is exactly `inventory_test`. Never touches `inventory_dev`. |
| `server`: `npm run db:check` / `npm run db:check:test` | Connects and lists tables | Read-only (dev / test database). |
| `server`: `npm run admin:create` | Creates the administrator | **WRITES** one row to `inventory_dev` after a typed confirmation. |
| `client`: `npm test` | Component and API tests with a fake `fetch` | None, and no server is needed. |
| `client`: `npm run build` | Production build into `client/dist` | None. |

`npm test` deliberately skips `tests/integration/`. Do not reorder the flags of the `test:integration` script:
the path must come first.
