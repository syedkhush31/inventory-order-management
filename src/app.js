const express = require('express');
const ordersRouter = require('./routes/orders');
const productsRouter = require('./routes/products');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(express.json());
app.use('/products', productsRouter);
app.use('/orders', ordersRouter);
app.use(errorHandler.notFound);
app.use(errorHandler.global);

module.exports = app;
