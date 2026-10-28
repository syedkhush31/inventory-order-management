// Turns database rows into the shape the API returns, creates orders and moves them through their statuses.
const orderRepository = require('../repositories/orderRepository');
const productRepository = require('../repositories/productRepository');
const stockAdjustmentRepository = require('../repositories/stockAdjustmentRepository');
const { withTransaction } = require('../config/db');
const { MAX_STOCK_QUANTITY } = require('../validation/productSchemas');
const { toCents, formatCents, lineCents, MAX_TOTAL_CENTS } = require('../utils/money');

// Money stays a string (e.g. "19.99") so it is never converted to a floating-point number.
function toOrderSummary(row) {
  return {
    id: Number(row.id),
    status: row.status,
    totalAmount: String(row.total_amount),
    itemCount: Number(row.item_count),
    customer: { id: Number(row.customer_id), name: row.customer_name, email: row.customer_email },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toItem(row) {
  return {
    id: Number(row.id),
    productId: Number(row.product_id),
    sku: row.sku,
    productName: row.product_name,
    quantity: Number(row.quantity),
    unitPrice: String(row.unit_price),
    lineTotal: formatCents(lineCents(row.unit_price, Number(row.quantity))),
  };
}

function toHistoryEntry(row) {
  return {
    id: Number(row.id),
    fromStatus: row.from_status,
    toStatus: row.to_status,
    changedByAdminId: Number(row.changed_by_admin_id),
    changedAt: row.changed_at,
  };
}

class OrderNotFoundError extends Error {
  constructor() {
    super('Order not found');
    this.name = 'OrderNotFoundError';
  }
}

// The customer in a new order does not exist (reason 'missing') or is deactivated (reason 'inactive').
class OrderCustomerError extends Error {
  constructor(reason) {
    super(reason === 'missing' ? 'Customer not found' : 'Customer is inactive');
    this.name = 'OrderCustomerError';
    this.reason = reason;
  }
}

// Some products in a new order do not exist (reason 'missing') or are deactivated (reason 'inactive').
class OrderProductsError extends Error {
  constructor(reason, productIds) {
    super(reason === 'missing' ? 'Some products do not exist' : 'Some products are inactive');
    this.name = 'OrderProductsError';
    this.reason = reason;
    this.productIds = productIds;
  }
}

class OrderTotalTooLargeError extends Error {
  constructor() {
    super('The order total is too large');
    this.name = 'OrderTotalTooLargeError';
  }
}

async function listOrders(query) {
  const { rows, total } = await orderRepository.list(query);
  return {
    items: rows.map(toOrderSummary),
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.ceil(total / query.pageSize),
  };
}

// One order with its customer, its lines (price snapshots) and its status history.
async function getOrder(id) {
  const row = await orderRepository.findById(id);
  if (!row) {
    throw new OrderNotFoundError();
  }
  const [items, history] = await Promise.all([orderRepository.listItems(id), orderRepository.listStatusHistory(id)]);
  return {
    id: Number(row.id),
    status: row.status,
    totalAmount: String(row.total_amount),
    customer: {
      id: Number(row.customer_id),
      name: row.customer_name,
      email: row.customer_email,
      isActive: Boolean(row.customer_is_active),
    },
    items: items.map(toItem),
    statusHistory: history.map(toHistoryEntry),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Creates a PENDING order. Everything happens in ONE transaction: the order, its lines and its first status
// record are all saved or none are. Prices come from the database (the request cannot contain one), the total is
// added up in whole cents, and stock is NOT touched: it is checked and deducted when the order is confirmed.
//
// Returns { order } with the full order read back after the commit. If that read fails, the order is already
// saved, so an error would be wrong (a client that retries would create a second order). Instead it returns
// { order: null, created: { orderId, status, totalAmount } }: only values known for certain, never a made-up order.
// The creation is never retried here.
async function createOrder({ customerId, items, adminId }) {
  const created = await withTransaction(async (connection) => {
    const customer = await orderRepository.findCustomerForOrder(connection, customerId);
    if (!customer) {
      throw new OrderCustomerError('missing');
    }
    if (!customer.is_active) {
      throw new OrderCustomerError('inactive');
    }

    const requestedIds = items.map((item) => item.productId);
    const products = await orderRepository.findProductsForOrder(connection, requestedIds);
    const byId = new Map(products.map((product) => [Number(product.id), product]));

    const missing = requestedIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new OrderProductsError('missing', missing);
    }
    const inactive = requestedIds.filter((id) => !byId.get(id).is_active);
    if (inactive.length > 0) {
      throw new OrderProductsError('inactive', inactive);
    }

    let totalCents = 0;
    const lines = items.map((item) => {
      const unitPrice = formatCents(toCents(byId.get(item.productId).price));
      totalCents += lineCents(unitPrice, item.quantity);
      return { productId: item.productId, quantity: item.quantity, unitPrice };
    });
    if (!Number.isSafeInteger(totalCents) || totalCents > MAX_TOTAL_CENTS) {
      throw new OrderTotalTooLargeError();
    }

    const newOrderId = await orderRepository.insertOrder(connection, {
      customerId,
      totalAmount: formatCents(totalCents),
    });
    await orderRepository.insertItems(connection, newOrderId, lines);
    await orderRepository.insertStatusHistory(connection, {
      orderId: newOrderId,
      fromStatus: null,
      toStatus: 'PENDING',
      adminId,
    });
    return { orderId: newOrderId, status: 'PENDING', totalAmount: formatCents(totalCents) };
  });

  try {
    return { order: await getOrder(created.orderId) };
  } catch (err) {
    // Only a short category is logged: database errors can contain query text and values.
    console.error(`Order ${created.orderId} was saved but could not be read back: ${err.code || err.name}`);
    return { order: null, created };
  }
}

// ---- Status changes (Phase 2) ----

// The only allowed moves. Anything else (including repeating a move that already happened) is refused.
// Stock changes only when an order becomes CONFIRMED (deduct) or goes from CONFIRMED to CANCELLED (restore).
const ALLOWED_TRANSITIONS = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

// The order cannot move from its current status to the requested one. currentStatus is what it is right now.
class OrderTransitionError extends Error {
  constructor(currentStatus, requestedStatus) {
    super(
      currentStatus === requestedStatus
        ? `This order is already ${currentStatus}`
        : `This order is ${currentStatus} and cannot be changed to ${requestedStatus}`
    );
    this.name = 'OrderTransitionError';
    this.currentStatus = currentStatus;
    this.requestedStatus = requestedStatus;
  }
}

// Confirming would need more of some products than are in stock. shortages: [{ productId, requested, available }].
class OrderStockError extends Error {
  constructor(shortages) {
    super('Not enough stock to confirm this order');
    this.name = 'OrderStockError';
    this.shortages = shortages;
  }
}

// Restoring the stock of a cancelled order would go past the largest quantity the stock column can hold.
class OrderStockLimitError extends Error {
  constructor(productIds) {
    super('Restoring stock would exceed the maximum stock quantity');
    this.name = 'OrderStockLimitError';
    this.productIds = productIds;
  }
}

// MySQL gave up waiting for a row lock held by another transaction, or chose this transaction as the loser of a
// deadlock. In both cases the transaction has been rolled back and nothing was saved, so trying again later is safe.
// Only these two codes mean that: every other database error stays a generic failure.
const BUSY_ERROR_CODES = new Set(['ER_LOCK_WAIT_TIMEOUT', 'ER_LOCK_DEADLOCK']);

class OrderBusyError extends Error {
  constructor() {
    super('The order is busy; please try again.');
    this.name = 'OrderBusyError';
  }
}

// Locks every product in the order, lowest id first (so two orders that share products always lock them in the same
// order and cannot wait on each other), and returns [{ productId, quantity, current }] in that order.
async function lockOrderProducts(connection, orderId) {
  const lines = (await orderRepository.listItemQuantities(connection, orderId))
    .map((row) => ({ productId: Number(row.product_id), quantity: Number(row.quantity) }))
    .sort((a, b) => a.productId - b.productId);

  const locked = [];
  for (const line of lines) {
    const product = await productRepository.lockForUpdate(connection, line.productId);
    if (!product) {
      // Cannot happen while the foreign key keeps products from being deleted; refuse rather than guess.
      throw new Error('An ordered product no longer exists');
    }
    locked.push({ ...line, current: Number(product.stock_quantity) });
  }
  return locked;
}

// PENDING -> CONFIRMED: takes the ordered quantities out of stock. Either every product has enough and all of them
// are deducted, or the error aborts the transaction and nothing changes.
async function deductStock(connection, orderId, adminId) {
  const locked = await lockOrderProducts(connection, orderId);

  const shortages = locked
    .filter((line) => line.current < line.quantity)
    .map((line) => ({ productId: line.productId, requested: line.quantity, available: line.current }));
  if (shortages.length > 0) {
    throw new OrderStockError(shortages);
  }

  for (const line of locked) {
    await productRepository.setStockQuantity(connection, line.productId, line.current - line.quantity);
    await stockAdjustmentRepository.insertOrderMovement(connection, {
      productId: line.productId,
      quantityDelta: -line.quantity,
      reason: `Order #${orderId} confirmed`,
      adminId,
      orderId,
      movementType: 'ORDER_CONFIRMED',
    });
  }
}

// CONFIRMED -> CANCELLED: puts the ordered quantities back. Only reachable once per order, because the status
// leaves CONFIRMED in the same transaction (and the unique key on stock_adjustments is a second guard).
async function restoreStock(connection, orderId, adminId) {
  const locked = await lockOrderProducts(connection, orderId);

  const overflowing = locked.filter((line) => line.current + line.quantity > MAX_STOCK_QUANTITY);
  if (overflowing.length > 0) {
    throw new OrderStockLimitError(overflowing.map((line) => line.productId));
  }

  for (const line of locked) {
    await productRepository.setStockQuantity(connection, line.productId, line.current + line.quantity);
    await stockAdjustmentRepository.insertOrderMovement(connection, {
      productId: line.productId,
      quantityDelta: line.quantity,
      reason: `Order #${orderId} cancelled`,
      adminId,
      orderId,
      movementType: 'ORDER_CANCELLED',
    });
  }
}

// Moves an order to a new status in ONE transaction: lock the order, check the move is allowed from the status it
// has right now, change stock if the move requires it, write the new status and the status-history record. Any
// failure rolls everything back, so there is never a status without its stock change or the other way round.
//
// Returns { order } with the full order read back after the commit. If that read fails the change is already saved,
// so (as in createOrder) it returns { order: null, changed: { orderId, status } } instead of an error.
async function changeStatus({ orderId, to, adminId }) {
  try {
    await runStatusChange({ orderId, to, adminId });
  } catch (err) {
    // withTransaction has already rolled back (and released the connection) by the time the error gets here.
    if (err && BUSY_ERROR_CODES.has(err.code)) {
      console.error(`Order ${orderId} could not be changed to ${to}: ${err.code}`);
      throw new OrderBusyError();
    }
    throw err;
  }

  try {
    return { order: await getOrder(orderId) };
  } catch (err) {
    // Only a short category is logged: database errors can contain query text and values.
    console.error(`Order ${orderId} changed to ${to} but could not be read back: ${err.code || err.name}`);
    return { order: null, changed: { orderId, status: to } };
  }
}

// The transaction itself (see changeStatus).
async function runStatusChange({ orderId, to, adminId }) {
  await withTransaction(async (connection) => {
    const order = await orderRepository.lockOrder(connection, orderId);
    if (!order) {
      throw new OrderNotFoundError();
    }
    const from = order.status;
    if (!(ALLOWED_TRANSITIONS[from] || []).includes(to)) {
      throw new OrderTransitionError(from, to);
    }

    if (to === 'CONFIRMED') {
      await deductStock(connection, orderId, adminId);
    } else if (to === 'CANCELLED' && from === 'CONFIRMED') {
      await restoreStock(connection, orderId, adminId);
    }

    await orderRepository.updateStatus(connection, orderId, to);
    await orderRepository.insertStatusHistory(connection, { orderId, fromStatus: from, toStatus: to, adminId });
  });
}

const confirmOrder = (orderId, adminId) => changeStatus({ orderId, to: 'CONFIRMED', adminId });
const cancelOrder = (orderId, adminId) => changeStatus({ orderId, to: 'CANCELLED', adminId });
const shipOrder = (orderId, adminId) => changeStatus({ orderId, to: 'SHIPPED', adminId });
const deliverOrder = (orderId, adminId) => changeStatus({ orderId, to: 'DELIVERED', adminId });

module.exports = {
  listOrders,
  getOrder,
  createOrder,
  confirmOrder,
  cancelOrder,
  shipOrder,
  deliverOrder,
  ALLOWED_TRANSITIONS,
  OrderNotFoundError,
  OrderCustomerError,
  OrderProductsError,
  OrderTotalTooLargeError,
  OrderTransitionError,
  OrderStockError,
  OrderStockLimitError,
  OrderBusyError,
};
