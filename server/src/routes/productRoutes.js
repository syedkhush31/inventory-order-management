const express = require('express');
const authenticate = require('../middleware/authenticate');
const productService = require('../services/productService');
const { productListQuerySchema, createProductSchema } = require('../validation/productSchemas');

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
      if (err instanceof productService.DuplicateSkuError) {
        return res.status(409).json({ error: 'A product with this SKU already exists', fields: ['sku'] });
      }
      throw err; // anything else becomes the generic 500 from the error handler
    }
  });

  return router;
}

module.exports = createProductRouter;
