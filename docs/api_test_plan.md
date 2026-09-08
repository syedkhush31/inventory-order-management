# API Postman test plan

Set `baseUrl` (for example, `http://localhost:3000`) as a Postman environment
variable. Before each order test, use known product fixtures and record each product's
ID, price, and starting `stock_qty`. Send JSON bodies with
`Content-Type: application/json`.

## POST {{baseUrl}}/orders

### Valid order

1. Choose an existing product with at least two units in stock.
2. Send `POST {{baseUrl}}/orders` with:

   ```json
   {
     "product_id": 123,
     "quantity": 2
   }
   ```

3. Expect HTTP `201` and a response containing a numeric `order_id` and
   `"message": "Order placed successfully"`.
4. Verify in MySQL that one `orders` record and one matching `order_items` record
   exist, `price_at_order` equals the product price at placement time, and the
   product's `stock_qty` decreased by two.

### Invalid quantity

1. Send requests using a zero, negative, non-integer, or missing `quantity`, such
   as:

   ```json
   {
     "product_id": 123,
     "quantity": 0
   }
   ```

2. Expect HTTP `400` with `{ "error": "Invalid quantity" }`.
3. Verify that no order, order item, or stock change was committed.

### Product not found

1. Send a positive quantity with an ID that does not exist:

   ```json
   {
     "product_id": 999999,
     "quantity": 1
   }
   ```

2. Expect HTTP `404` with `{ "error": "Product not found" }`.
3. Verify that no order or order item was created.

### Insufficient stock

1. Select an existing product whose stock is lower than the request quantity.
2. Send a request such as:

   ```json
   {
     "product_id": 123,
     "quantity": 999
   }
   ```

3. Expect HTTP `409` with `{ "error": "Insufficient stock" }`.
4. Verify that stock and order-related rows are unchanged.

### Concurrency test: two parallel requests

1. Create or select one product with exactly one unit in stock.
2. Prepare two identical requests for that product and `quantity: 1`.
3. Use Postman Collection Runner with two iterations and a parallel run, or send both
   requests simultaneously from two Postman tabs/clients.
4. Expect exactly one request to return HTTP `201` and one to return HTTP `409` with
   `Insufficient stock`.
5. Verify that stock is `0`, only one order item was created for this test, and the
   stock quantity never became negative. This demonstrates that the row lock prevents
   both requests from consuming the same unit.

## GET endpoints (planned; do not test until implemented)

### GET {{baseUrl}}/products

When implemented, request the collection and verify HTTP `200`, a JSON list of
products, expected product fields, and that the seeded fixtures appear with accurate
stock and prices.

### GET {{baseUrl}}/products/:id

When implemented, request a known product ID and verify HTTP `200` and its complete
product representation. Request an unknown ID and verify the documented not-found
response and status code.

### GET {{baseUrl}}/orders/:id

When implemented, use the `order_id` captured from the valid-order test. Verify HTTP
`200`, order status and timestamp, and its associated item details including product,
quantity, and `price_at_order`. Also request a nonexistent ID and verify the
documented not-found response and status code.
