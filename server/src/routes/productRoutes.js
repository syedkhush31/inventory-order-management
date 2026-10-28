const express = require('express');
const authenticate = require('../middleware/authenticate');
const productService = require('../services/productService');
const {
  productListQuerySchema,
  createProductSchema,
  updateProductSchema,
  productIdSchema,
  stockAdjustmentSchema,
  stockHistoryQuerySchema,
} = require('../validation/productSchemas');

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
  const parsed = productIdSchema.safeParse(req.params.id);
  if (!parsed.success) {
    invalidRequest(res, [{ code: 'custom', path: ['id'] }]);
    return null;
  }
  return parsed.data;
}

// Turns the errors the service knows about into responses. Anything else becomes the generic 500.
function sendKnownError(res, err) {
  if (err instanceof productService.DuplicateSkuError) {
    return res.status(409).json({ error: 'A product with this SKU already exists', fields: ['sku'] });
  }
  if (err instanceof productService.ProductNotFoundError) {
    return res.status(404).json({ error: 'Product not found' });
  }
  if (err instanceof productService.InsufficientStockError || err instanceof productService.StockLimitError) {
    return res.status(409).json({ error: err.message, fields: ['delta'], currentStock: err.currentStock });
  }
  return null;
}

function createProductRouter() {
  const router = express.Router();

  // Every product route requires a signed-in administrator.
  router.use(authenticate);

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // GET /api/products?q=&status=active|inactive|all&page=&pageSize=&sort=&order=
  router.get('/', async (req, res) => {
    const parsed = productListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return invalidRequest(res, parsed.error.issues);
    }
    return res.json(await productService.listProducts(parsed.data));
  });

  // POST /api/products  { sku, name, price: "19.99", stockQuantity?: 0 }  ->  201 { product }
  router.post('/', async (req, res) => {
    const parsed = createProductSchema.safeParse(req.body);
    if (!parsed.success) {
      return invalidRequest(res, parsed.error.issues);
    }

    try {
      const product = await productService.createProduct(parsed.data);
      return res.status(201).json({ product });
    } catch (err) {
      return sendKnownError(res, err) || Promise.reject(err); // anything else becomes the generic 500
    }
  });

  // PATCH /api/products/:id  { sku?, name?, price? }  ->  200 { product }
  router.patch('/:id', async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return undefined;
    const parsed = updateProductSchema.safeParse(req.body);
    if (!parsed.success) {
      return invalidRequest(res, parsed.error.issues);
    }

    try {
      return res.json({ product: await productService.updateProduct(id, parsed.data) });
    } catch (err) {
      return sendKnownError(res, err) || Promise.reject(err);
    }
  });

  // POST /api/products/:id/deactivate and /reactivate  ->  200 { product }. Repeating either is harmless.
  for (const [action, isActive] of [['deactivate', false], ['reactivate', true]]) {
    router.post(`/:id/${action}`, async (req, res) => {
      const id = parseId(req, res);
      if (id === null) return undefined;

      try {
        return res.json({ product: await productService.setProductActive(id, isActive) });
      } catch (err) {
        return sendKnownError(res, err) || Promise.reject(err);
      }
    });
  }

  // GET /api/products/:id/stock-adjustments?page=&pageSize=  ->  200 { items, page, pageSize, total, totalPages }
  // Read-only. Newest first. Each item: { id, productId, quantityDelta, reason, adminId, createdAt }.
  router.get('/:id/stock-adjustments', async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return undefined;
    const parsed = stockHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return invalidRequest(res, parsed.error.issues);
    }

    try {
      return res.json(await productService.listStockAdjustments(id, parsed.data));
    } catch (err) {
      return sendKnownError(res, err) || Promise.reject(err);
    }
  });

  // POST /api/products/:id/stock-adjustments  { delta: -3, reason: "Damaged in storage" }
  //   ->  201 { product, adjustment }.  409 if stock would go below 0 or above the column maximum.
  router.post('/:id/stock-adjustments', async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return undefined;
    const parsed = stockAdjustmentSchema.safeParse(req.body);
    if (!parsed.success) {
      return invalidRequest(res, parsed.error.issues);
    }

    try {
      const result = await productService.adjustStock({
        productId: id,
        delta: parsed.data.delta,
        reason: parsed.data.reason,
        adminId: Number(req.admin.id),
      });
      return res.status(201).json(result);
    } catch (err) {
      return sendKnownError(res, err) || Promise.reject(err);
    }
  });

  return router;
}

module.exports = createProductRouter;
