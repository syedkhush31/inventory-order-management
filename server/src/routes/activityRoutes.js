const express = require('express');
const authenticate = require('../middleware/authenticate');
const activityService = require('../services/activityService');
const { activityQuerySchema } = require('../validation/activitySchemas');

// Names of the fields that failed validation.
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

function createActivityRouter() {
  const router = express.Router();

  // Every activity route requires a signed-in administrator.
  router.use(authenticate);

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // GET /api/activity?q=&type=all|order|stock|product|customer|account|settings&from=&to=&page=&pageSize=
  //   ->  200 { items, page, pageSize, total, totalPages }, newest first. Read-only.
  // Each item: { id, type, occurredAt, actor: { id, email, displayName }, entity: { type, id, label }, details }.
  router.get('/', async (req, res) => {
    const parsed = activityQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', fields: failedFields(parsed.error.issues) });
    }
    return res.json(await activityService.listActivity(parsed.data));
  });

  return router;
}

module.exports = createActivityRouter;
