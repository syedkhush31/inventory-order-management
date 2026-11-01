const express = require('express');
const authenticate = require('../middleware/authenticate');
const { createPasswordChangeLimiter } = require('../middleware/rateLimiters');
const accountService = require('../services/accountService');
const authService = require('../services/authService');
const { updateProfileSchema, changePasswordSchema } = require('../validation/accountSchemas');
const { setSessionCookie } = require('../utils/sessionCookie');

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

// Turns the errors the service knows about into responses. Anything else becomes the generic 500.
function sendKnownError(res, err) {
  if (err instanceof accountService.AccountNotFoundError) {
    // The signed-in account no longer exists or was deactivated in between: the session is over.
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (err instanceof accountService.CurrentPasswordRequiredError) {
    return res.status(400).json({ error: 'Invalid request', fields: ['currentPassword'] });
  }
  if (err instanceof accountService.CurrentPasswordError) {
    // 403, not 401: the person IS signed in, they typed the wrong password. (401 would sign them out in the app.)
    return res.status(403).json({ error: 'Current password is incorrect', fields: ['currentPassword'] });
  }
  if (err instanceof accountService.DuplicateAccountEmailError) {
    return res.status(409).json({ error: 'Another account already uses this email', fields: ['email'] });
  }
  return null;
}

// Wraps the password-attempt limiter so that it only runs for a profile edit that will actually check the current
// password: an email change to a DIFFERENT address. A display-name-only edit (or an email "change" to the address already
// in use) never asks for the password, so it is not counted and is never blocked by the limiter. A body that does not
// pass validation skips the limiter too; the handler answers it with the usual 400. `req.admin.email` is the stored
// email that authenticate just read.
function limitWhenPasswordIsChecked(passwordLimiter) {
  return (req, res, next) => {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (parsed.success && accountService.requiresCurrentPassword(parsed.data, req.admin.email)) {
      return passwordLimiter(req, res, next);
    }
    return next();
  };
}

function createAccountRouter({ passwordLimiter = createPasswordChangeLimiter() } = {}) {
  const router = express.Router();

  // Every account route requires a signed-in administrator, and only ever acts on THAT administrator's own account:
  // the id always comes from the verified session, never from the URL or the body.
  router.use(authenticate);

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // GET /api/account  ->  200 { account: { id, email, displayName, createdAt } }
  router.get('/', async (req, res) => {
    try {
      return res.json({ account: await accountService.getAccount(req.admin.id) });
    } catch (err) {
      return sendKnownError(res, err) || Promise.reject(err);
    }
  });

  // PATCH /api/account/profile  { displayName?: string | null, email?: string, currentPassword?: string }
  //   ->  200 { account }. Changing the email needs currentPassword: 400 if it is missing, 403 if it is wrong, 409 if
  //   another account already uses the email. A change that changes nothing is a 200 that writes nothing.
  //   The password-attempt limiter (shared with POST /password) applies only when the email is being changed.
  router.patch('/profile', limitWhenPasswordIsChecked(passwordLimiter), async (req, res) => {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      return invalidRequest(res, parsed.error.issues);
    }

    try {
      return res.json({ account: await accountService.updateProfile(req.admin.id, parsed.data) });
    } catch (err) {
      return sendKnownError(res, err) || Promise.reject(err);
    }
  });

  // POST /api/account/password  { currentPassword, newPassword }  ->  200 { message }, plus a NEW login cookie.
  //   The password and the session version change together, so every other session ends at once. 403 for a wrong
  //   current password (counted by the limiter: 5 per 15 minutes per administrator, then 429).
  router.post('/password', passwordLimiter, async (req, res) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return invalidRequest(res, parsed.error.issues);
    }

    try {
      const session = await accountService.changePassword(req.admin.id, parsed.data);
      setSessionCookie(res, authService.signToken(session));
      return res.json({ message: 'Password changed. Other sessions have been signed out.' });
    } catch (err) {
      return sendKnownError(res, err) || Promise.reject(err);
    }
  });

  return router;
}

module.exports = createAccountRouter;
