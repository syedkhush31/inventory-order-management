
## Stock-concurrency learning goal

Concurrent orders can oversell inventory when each request independently checks the
same available stock and later updates it: both requests can observe enough stock
before either deduction is committed. Handle order creation in a MySQL transaction
and read the relevant `products` row with `SELECT ... FOR UPDATE` before validating
and decrementing stock. The resulting row-level lock serializes competing stock
deductions for that product, preventing overselling when the transaction commits or
rolls back. Understanding this row-level locking behavior is a core learning goal of
this project.
