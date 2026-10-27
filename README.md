# Inventory & Order Management System

Full-stack app: React (Vite) frontend, Express API, MySQL database. JavaScript only.

## Structure
- `server/` Express API (config, middleware, routes, validation, services, repositories, tests, database scripts, simulation scripts)
- `client/` React + Vite app (pages, components, API utilities, tests)
- `docs/` Design notes, e.g. the authentication plan

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
Make sure `NODE_ENV` is not set in your terminal.

## Status
Frontend milestone 1 is built: administrator login, session check, logout and a basic dashboard shell.
Inventory, orders and customers are not built yet.

Scaffold only. No features, API routes or tests are implemented yet.
