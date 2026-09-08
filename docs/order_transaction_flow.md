# Safe order-placement transaction flow

This specification applies to one requested product and quantity. All statements
below must use the same MySQL connection and run in one transaction on InnoDB
tables.

1. Begin the transaction.

   ```sql
   START TRANSACTION;
   ```

2. Lock and read the product that will be ordered.

   ```sql
   SELECT id, price, stock_qty
   FROM products
   WHERE id = ?
   FOR UPDATE;
   ```

   `SELECT ... FOR UPDATE` is required because it acquires an exclusive row-level
   lock on the selected product until the transaction commits or rolls back. The
   stock check and stock deduction can therefore be treated as one serialized
   operation for that product.

3. Validate the request using the locked row.

   - Roll back if no product was returned.
   - Roll back if the requested quantity is not greater than zero.
   - Roll back if `stock_qty` is less than the requested quantity.
   - Otherwise, retain the product's current `price` as `price_at_order` and
     continue.

4. Create the order with its initial status.

   ```sql
   INSERT INTO orders (status)
   VALUES ('CONFIRMED');
   ```

   Store the newly generated order ID for the next statement.

5. Create the order line using the locked product price.

   ```sql
   INSERT INTO order_items (order_id, product_id, quantity, price_at_order)
   VALUES (?, ?, ?, ?);
   ```

6. Deduct stock while the product row is still locked.

   ```sql
   UPDATE products
   SET stock_qty = stock_qty - ?
   WHERE id = ?;
   ```

7. Commit only after every validation and SQL statement above succeeds.

   ```sql
   COMMIT;
   ```

8. Roll back on any failure.

   ```sql
   ROLLBACK;
   ```

   A rollback is required for failed validation, a missing product, insufficient
   stock, invalid quantity, an insert/update error, a foreign-key or check-constraint
   violation, a deadlock, a timeout, or any other database/application error before
   commit. It releases the product-row lock and leaves no partially created order,
   order item, or stock deduction.

## Concurrent requests for the same product

If two requests attempt to order the same product, the first request that obtains
the `FOR UPDATE` lock performs its validation and stock update first. The second
request waits for that row-level lock to be released. After the first request commits,
the second request reads the newly reduced `stock_qty` and can commit only if enough
stock remains; otherwise it rolls back. If the first request rolls back, the second
request reads the unchanged stock after acquiring the lock. This prevents both
requests from validating against the same stale quantity and overselling inventory.

The transaction may commit only when the product exists, quantity is positive, the
locked stock is sufficient, and the order insert, item insert, and stock update all
succeed. For orders with multiple products, lock every involved product row in a
consistent order before validating and updating, so the same guarantees apply while
reducing deadlock risk.
