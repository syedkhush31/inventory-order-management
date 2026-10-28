// Builds the Express app. Product and customer routes are mounted behind the authenticate middleware;
// order routes arrive in a later phase.
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const env = require('./config/env');
const requireSameOrigin = require('./middleware/requireSameOrigin');
const createAuthRouter = require('./routes/authRoutes');
const createProductRouter = require('./routes/productRoutes');
const createCustomerRouter = require('./routes/customerRoutes');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(helmet());
app.use(cors({ origin: env.clientOrigin, credentials: true }));
app.use(requireSameOrigin);
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

app.use('/api/auth', createAuthRouter());
app.use('/api/products', createProductRouter());
app.use('/api/customers', createCustomerRouter());

app.use(notFound);
app.use(errorHandler);

module.exports = app;
