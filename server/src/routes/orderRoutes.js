const express = require('express');
const authenticate = require('../middleware/authenticate');
const orderService = require('../services/orderService');
const { orderListQuerySchema, createOrderSchema, orderIdSchema } = require('../validation/orderSchemas');

// Names of the fields that failed validation. Unknown properties are reported by name too.
function failedFields(issues) {
  const names = [];
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      names.push(...issue.keys);
    } else {
      names.push(issue.path.join('.'));
    }
  }
  return [...new Set(names.filter(Boolean))];
}

function invalidRequest(res, issues) {
  return res.status(400).json({ error: 'Invalid request', fields: failedFields(issues) });
}

// Reads :id from the URL. Sends the 400 itself and returns null when it is not a valid id.
function parseId(req, res) {
  const parsed = orderIdSchema.safeParse(req.params.id);
  if (!parsed.success) {
    invalidRequest(res, [{ code: 'custom', path: ['id'] }]);
    return null;
  }
  return parsed.data;
}

// Turns the errors the service knows about into responses. Anything else becomes the generic 500.
function sendKnownError(res, err) {
  if (err instanceof orderService.OrderNotFoundError) {
    return res.status(404).json({ error: 'Order not found' });
  }
  if (err instanceof orderService.OrderCustomerError) {
    return err.reason === 'missing'
      ? res.status(400).json({ error: 'Customer not found', fields: ['customerId'] })
      : res.status(409).json({ error: 'Customer is inactive', fields: ['customerId'] });
  }
  if (err instanceof orderService.OrderProductsError) {
    const status = err.reason === 'missing' ? 400 : 409;
    return res.status(status).json({ error: err.message, fields: ['items'], productIds: err.productIds });
  }
  if (err instanceof orderService.OrderTotalTooLargeError) {
    return res.status(400).json({ error: 'The order total is too large', fields: ['items'] });
  }
  if (err instanceof orderService.OrderTransitionError) {
    return res.status(409).json({ error: err.message, currentStatus: err.currentStatus });
  }
  if (err instanceof orderService.OrderStockError) {
    return res.status(409).json({ error: err.message, shortages: err.shortages });
  }
  if (err instanceof orderService.OrderStockLimitError) {
    return res.status(409).json({ error: err.message, productIds: err.productIds });
  }
  if (err instanceof orderService.OrderBusyError) {
    // Another request held a lock on this order or one of its products for too long, or MySQL ended this one to break
    // a deadlock. Nothing was saved. Only the status-change routes can produce this error.
    res.set('Retry-After', '2');
    return res.status(503).json({ error: err.message });
  }
  return null;
}

function createOrderRouter() {
  const router = express.Router();

  // Every order route requires a signed-in administrator.
  router.use(authenticate);

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // GET /api/orders?q=&status=all|PENDING|...&page=&pageSize=&sort=&order=
  router.get('/', async (req, res) => {
    const parsed = orderListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return invalidRequest(res, parsed.error.issues);
    }
    return res.json(await orderService.listOrders(parsed.data));
  });

  // POST /api/orders  { customerId, items: [{ productId, quantity }] }  ->  201 { order }
  // The body cannot carry prices, totals or a status: the server decides all three.
  // If the order was saved but could not be read back, the answer is still 201, with order: null and only the
  // values known for certain, so the client does not submit the same order again.
  router.post('/', async (req, res) => {
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return invalidRequest(res, parsed.error.issues);
    }

    try {
      const { order, created } = await orderService.createOrder({ ...parsed.data, adminId: req.admin.id });
      if (order) {
        return res.status(201).json({ order });
      }
      return res.status(201).json({
        order: null,
        orderId: created.orderId,
        status: created.status,
        totalAmount: created.totalAmount,
        detailsAvailable: false,
        message: `Order #${created.orderId} was created, but its details could not be loaded. Do not submit it again; find it in the orders list.`,
      });
    } catch (err) {
      return sendKnownError(res, err) || Promise.reject(err); // anything else becomes the generic 500
    }
  });

  // GET /api/orders/:id  ->  200 { order } with customer, items (price snapshots) and statusHistory
  router.get('/:id', async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return undefined;

    try {
      return res.json({ order: await orderService.getOrder(id) });
    } catch (err) {
      return sendKnownError(res, err) || Promise.reject(err);
    }
  });

  // POST /api/orders/:id/confirm | cancel | ship | deliver  (no body needed)  ->  200 { order }
  // confirm deducts stock and cancelling a CONFIRMED order restores it; ship and deliver never touch stock.
  // A move that is not allowed from the order's current status, including repeating one, is 409 and changes nothing.
  // If the change was saved but the order could not be read back, the answer is still 200 with order: null.
  const actions = [
    ['confirm', orderService.confirmOrder, 'CONFIRMED'],
    ['cancel', orderService.cancelOrder, 'CANCELLED'],
    ['ship', orderService.shipOrder, 'SHIPPED'],
    ['deliver', orderService.deliverOrder, 'DELIVERED'],
  ];
  for (const [action, change, status] of actions) {
    router.post(`/:id/${action}`, async (req, res) => {
      const id = parseId(req, res);
      if (id === null) return undefined;

      try {
        const { order } = await change(id, req.admin.id);
        if (order) {
          return res.json({ order });
        }
        return res.json({
          order: null,
          orderId: id,
          status,
          detailsAvailable: false,
          message: `Order #${id} is now ${status}, but its details could not be loaded. Do not repeat the action; open the order to check it.`,
        });
      } catch (err) {
        return sendKnownError(res, err) || Promise.reject(err);
      }
    });
  }

  return router;
}

module.exports = createOrderRouter;
