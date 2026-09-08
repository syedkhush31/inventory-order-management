const express = require('express');
const mysql = require('mysql2/promise');

const router = express.Router();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'inventory_order_management',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 10,
});

router.post('/', async (req, res) => {
  const { product_id: productId, quantity } = req.body;
  const isValidQuantity = Number.isInteger(quantity) && quantity > 0;
  let connection;
  let transactionStarted = false;

  try {
    connection = await pool.getConnection();
    await connection.query('START TRANSACTION');
    transactionStarted = true;

    const [products] = await connection.execute(
      `SELECT id, price, stock_qty
       FROM products
       WHERE id = ?
       FOR UPDATE`,
      [productId],
    );

    if (products.length === 0) {
      await connection.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = products[0];

    if (!isValidQuantity) {
      await connection.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'Invalid quantity' });
    }

    if (product.stock_qty < quantity) {
      await connection.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({ error: 'Insufficient stock' });
    }

    const [orderResult] = await connection.execute(
      "INSERT INTO orders (status) VALUES ('CONFIRMED')",
    );

    await connection.execute(
      `INSERT INTO order_items (order_id, product_id, quantity, price_at_order)
       VALUES (?, ?, ?, ?)`,
      [orderResult.insertId, product.id, quantity, product.price],
    );

    const [stockResult] = await connection.execute(
      `UPDATE products
       SET stock_qty = stock_qty - ?
       WHERE id = ?`,
      [quantity, product.id],
    );

    if (stockResult.affectedRows !== 1) {
      throw new Error('Product stock update failed');
    }

    await connection.query('COMMIT');
    transactionStarted = false;

    return res.status(201).json({
      order_id: orderResult.insertId,
      message: 'Order placed successfully',
    });
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.query('ROLLBACK');
      } catch (rollbackError) {
        // Preserve the original error; the connection is released below.
      }
    }

    return res.status(500).json({ error: 'Unable to place order' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [orders] = await pool.execute(
      `SELECT id, status, created_at
       FROM orders
       WHERE id = ?`,
      [req.params.id],
    );

    if (orders.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orders[0];
    const [items] = await pool.execute(
      `SELECT product_id, quantity, price_at_order
       FROM order_items
       WHERE order_id = ?`,
      [order.id],
    );

    return res.status(200).json({ ...order, items });
  } catch (error) {
    return res.status(500).json({ error: 'Unable to fetch order' });
  }
});

module.exports = router;
