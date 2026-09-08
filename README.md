# Inventory & Order Management System

## Project Overview

Inventory & Order Management System is a REST API for viewing products and placing
single-product orders. It uses Node.js, Express, and MySQL. Order placement is
concurrency-safe: stock is checked and deducted inside a database transaction so
simultaneous requests cannot oversell the same product.

## Features

- Safe stock deduction for confirmed single-product orders
- Row-level product locking with `SELECT ... FOR UPDATE`
- Transaction-based order placement with commit and rollback handling
- Product list and detail endpoints
- Order-detail endpoint with associated items

## Database Schema Summary

The MySQL schema is defined in [database/schema.sql](database/schema.sql) and uses
InnoDB tables.

- `products` stores a product's name, unique SKU, price, and available stock.
- `orders` stores an order's status and creation timestamp.
- `order_items` stores the ordered product, quantity, and price at the time of the
  order.

`order_items.order_id` references `orders.id`, and `order_items.product_id`
references `products.id` with `ON DELETE RESTRICT`. The schema validates that product
prices and stock quantities are non-negative, and that order-item quantities are
positive and order-item prices are non-negative. Product SKUs are unique.

## Concurrency Explanation

Placing an order begins a MySQL transaction and reads the requested product using
`SELECT ... FOR UPDATE`. This takes an exclusive row-level lock until the transaction
commits or rolls back. A second request for the same product waits for that lock;
after it is released, it reads the stock resulting from the first transaction. It can
therefore commit only when sufficient stock remains, preventing two requests from
both accepting the same units. The full flow is documented in
[docs/order_transaction_flow.md](docs/order_transaction_flow.md).

## API Endpoints

| Method | Endpoint | Description |
| --- | --- | --- |
| `POST` | `/orders` | Place a concurrency-safe single-product order. |
| `GET` | `/products` | List all products. |
| `GET` | `/products/:id` | Return one product by ID. |
| `GET` | `/orders/:id` | Return an order and its items by ID. |

## How to Run Locally

1. Install the runtime dependencies:

   ```bash
   npm install express mysql2
   ```

2. Copy `.env.example` to `.env` and set the MySQL connection values.
3. Start MySQL, create the database named by `DB_NAME`, and load the schema:

   ```bash
   mysql -u root -p inventory_order_management < database/schema.sql
   ```

4. Ensure the project's start script loads the `.env` values and starts the Express
   app, then run:

   ```bash
   npm start
   ```

The route code reads `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, and
`DB_CONNECTION_LIMIT` from the process environment.

## Testing Instructions

Follow [docs/api_test_plan.md](docs/api_test_plan.md) in Postman. For the concurrency
test, set one product's stock to `1`, then send two parallel `POST /orders` requests
for that product with quantity `1`. Exactly one request should succeed and the other
should report insufficient stock; confirm the final stock is `0`.

## Future Enhancements

- Multi-product orders
- Pagination
- Authentication
- Admin dashboard
