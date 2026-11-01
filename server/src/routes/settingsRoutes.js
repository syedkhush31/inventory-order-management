const express = require('express');
const authenticate = require('../middleware/authenticate');
const settingsService = require('../services/settingsService');
const appInfoService = require('../services/appInfoService');
const { updateSettingsSchema } = require('../validation/settingsSchemas');

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

function createSettingsRouter() {
  const router = express.Router();

  // Every settings route requires a signed-in administrator.
  router.use(authenticate);

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // GET /api/settings  ->  200 { settings: { lowStockThreshold }, app: { name, serverVersion, clientVersion, environment } }
  // lowStockThreshold is 5 until a different value has been saved. app holds safe facts only (no secrets, no database
  // details); environment is "development" or "production".
  router.get('/', async (req, res) => {
    return res.json({ settings: await settingsService.getSettings(), app: appInfoService.getAppInfo() });
  });

  // PATCH /api/settings  { lowStockThreshold: 0..1000 }  ->  200 { settings }
  // Sending the value already in force changes and records nothing.
  router.patch('/', async (req, res) => {
    const parsed = updateSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', fields: failedFields(parsed.error.issues) });
    }
    return res.json({ settings: await settingsService.updateSettings(req.admin.id, parsed.data) });
  });

  return router;
}

module.exports = createSettingsRouter;
