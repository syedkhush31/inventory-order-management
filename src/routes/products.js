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

router.get('/', async (req, res) => {
  try {
    const [products] = await pool.execute(
      'SELECT id, name, sku, price, stock_qty FROM products',
    );

    return res.status(200).json(products);
  } catch (error) {
    return res.status(500).json({ error: 'Unable to fetch products' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [products] = await pool.execute(
      `SELECT id, name, sku, price, stock_qty
       FROM products
       WHERE id = ?`,
      [req.params.id],
    );

    if (products.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    return res.status(200).json(products[0]);
  } catch (error) {
    return res.status(500).json({ error: 'Unable to fetch product' });
  }
});

module.exports = router;
