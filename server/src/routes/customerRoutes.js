const express = require('express');
const authenticate = require('../middleware/authenticate');
const customerService = require('../services/customerService');
const {
  customerListQuerySchema,
  createCustomerSchema,
  updateCustomerSchema,
  customerIdSchema,
} = require('../validation/customerSchemas');

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
  const parsed = customerIdSchema.safeParse(req.params.id);
  if (!parsed.success) {
    invalidRequest(res, [{ code: 'custom', path: ['id'] }]);
    return null;
  }
  return parsed.data;
}

// Turns the errors the service knows about into responses. Anything else becomes the generic 500.
function sendKnownError(res, err) {
  if (err instanceof customerService.DuplicateEmailError) {
    return res.status(409).json({ error: 'A customer with this email already exists', fields: ['email'] });
  }
  if (err instanceof customerService.CustomerNotFoundError) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  return null;
}

function createCustomerRouter() {
  const router = express.Router();

  // Every customer route requires a signed-in administrator.
  router.use(authenticate);

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // GET /api/customers?q=&status=active|inactive|all&page=&pageSize=&sort=&order=
  router.get('/', async (req, res) => {
    const parsed = customerListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return invalidRequest(res, parsed.error.issues);
    }
    return res.json(await customerService.listCustomers(parsed.data));
  });

  // POST /api/customers  { name, email, phone?, address? }  ->  201 { customer }
  router.post('/', async (req, res) => {
    const parsed = createCustomerSchema.safeParse(req.body);
    if (!parsed.success) {
      return invalidRequest(res, parsed.error.issues);
    }

    try {
      return res.status(201).json({ customer: await customerService.createCustomer(parsed.data) });
    } catch (err) {
      return sendKnownError(res, err) || Promise.reject(err); // anything else becomes the generic 500
    }
  });

  // PATCH /api/customers/:id  { name?, email?, phone?, address? }  ->  200 { customer }
  router.patch('/:id', async (req, res) => {
    const id = parseId(req, res);
    if (id === null) return undefined;
    const parsed = updateCustomerSchema.safeParse(req.body);
    if (!parsed.success) {
      return invalidRequest(res, parsed.error.issues);
    }

    try {
      return res.json({ customer: await customerService.updateCustomer(id, parsed.data) });
    } catch (err) {
      return sendKnownError(res, err) || Promise.reject(err);
    }
  });

  // POST /api/customers/:id/deactivate and /reactivate  ->  200 { customer }. Repeating either is harmless.
  for (const [action, isActive] of [['deactivate', false], ['reactivate', true]]) {
    router.post(`/:id/${action}`, async (req, res) => {
      const id = parseId(req, res);
      if (id === null) return undefined;

      try {
        return res.json({ customer: await customerService.setCustomerActive(id, isActive) });
      } catch (err) {
        return sendKnownError(res, err) || Promise.reject(err);
      }
    });
  }

  return router;
}

module.exports = createCustomerRouter;
