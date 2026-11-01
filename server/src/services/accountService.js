// The signed-in administrator's own account: viewing and editing the profile, and changing the password.
// Anything that proves "it is really me" (changing the email, changing the password) checks the CURRENT password with
// bcrypt against the stored hash. Nothing in this file ever returns or logs a password or a hash.
const bcrypt = require('bcryptjs');
const adminRepository = require('../repositories/adminRepository');
const auditService = require('./auditService');
const authService = require('./authService');
const { withTransaction } = require('../config/db');

class AccountNotFoundError extends Error {
  constructor() {
    super('Account not found');
    this.name = 'AccountNotFoundError';
  }
}

// Changing the email needs the current password, and it was not sent.
class CurrentPasswordRequiredError extends Error {
  constructor() {
    super('The current password is required to change the email address');
    this.name = 'CurrentPasswordRequiredError';
  }
}

// The current password that was sent is wrong.
class CurrentPasswordError extends Error {
  constructor() {
    super('Current password is incorrect');
    this.name = 'CurrentPasswordError';
  }
}

class DuplicateAccountEmailError extends Error {
  constructor() {
    super('Another account already uses this email');
    this.name = 'DuplicateAccountEmailError';
  }
}

// True only for a duplicate on the email unique key (not for any other kind of database error).
function isDuplicateEmail(err) {
  return err && err.code === 'ER_DUP_ENTRY' && String(err.sqlMessage || '').includes('uq_admins_email');
}

// The shape the API returns. Only these four fields: never the hash, the session version or the active flag.
function toAccount(row) {
  return {
    id: Number(row.id),
    email: row.email,
    displayName: row.display_name ?? null,
    createdAt: row.created_at,
  };
}

// True when a profile edit really changes the email address, which is the only thing that needs the current password.
// The route uses it to decide whether the password-attempt limiter applies, and updateProfile uses the same rule to
// decide whether to check the password, so the two can never disagree. currentEmail is the stored email.
function requiresCurrentPassword(input, currentEmail) {
  return input.email !== undefined && input.email !== currentEmail;
}

async function getAccount(adminId) {
  const row = await adminRepository.findProfile(adminId);
  if (!row) {
    throw new AccountNotFoundError();
  }
  return toAccount(row);
}

// input: { displayName?, email?, currentPassword? } as validated by updateProfileSchema.
// Only a field that really changes is written. If nothing changes, nothing is written and nothing is audited.
// A changed email needs the correct current password. Everything happens in ONE transaction with the row locked, and
// the audit record (field NAMES only, never the values) is written in that same transaction.
async function updateProfile(adminId, input) {
  try {
    return await withTransaction(async (connection) => {
      const row = await adminRepository.findForUpdate(connection, adminId);
      if (!row || !row.is_active) {
        throw new AccountNotFoundError();
      }

      const changes = {};
      const changedFields = [];
      if (input.displayName !== undefined && (input.displayName ?? null) !== (row.display_name ?? null)) {
        changes.displayName = input.displayName;
        changedFields.push('displayName');
      }
      if (requiresCurrentPassword(input, row.email)) {
        if (input.currentPassword === undefined) {
          throw new CurrentPasswordRequiredError();
        }
        if (!(await bcrypt.compare(input.currentPassword, row.password_hash))) {
          throw new CurrentPasswordError();
        }
        changes.email = input.email;
        changedFields.push('email');
      }

      if (changedFields.length === 0) {
        return toAccount(row);
      }

      await adminRepository.updateProfile(connection, adminId, changes);
      await auditService.record(connection, {
        adminId,
        eventType: 'ACCOUNT_PROFILE_UPDATED',
        entityId: adminId,
        details: { changedFields },
      });
      return toAccount({
        ...row,
        email: changes.email ?? row.email,
        display_name: 'displayName' in changes ? changes.displayName : row.display_name,
      });
    });
  } catch (err) {
    if (isDuplicateEmail(err)) {
      throw new DuplicateAccountEmailError();
    }
    throw err;
  }
}

// input: { currentPassword, newPassword } as validated by changePasswordSchema.
// In ONE transaction, with the row locked: check the current password, store the new bcrypt hash AND raise the session
// version (a single statement, so they can not be out of step), and write the audit record (no details at all).
// Returns { id, email, tokenVersion } for the NEW session version, so the caller can issue a fresh login cookie.
async function changePassword(adminId, { currentPassword, newPassword }) {
  return withTransaction(async (connection) => {
    const row = await adminRepository.findForUpdate(connection, adminId);
    if (!row || !row.is_active) {
      throw new AccountNotFoundError();
    }
    if (!(await bcrypt.compare(currentPassword, row.password_hash))) {
      throw new CurrentPasswordError();
    }

    const passwordHash = await authService.hashPassword(newPassword);
    await adminRepository.updatePasswordAndBumpVersion(connection, adminId, passwordHash);
    await auditService.record(connection, { adminId, eventType: 'ACCOUNT_PASSWORD_CHANGED', entityId: adminId });

    // Read the new version back inside the transaction, so the cookie carries what the database really holds.
    const updated = await adminRepository.findForUpdate(connection, adminId);
    return { id: Number(updated.id), email: updated.email, tokenVersion: authService.versionOf(updated) };
  });
}

module.exports = {
  requiresCurrentPassword,
  getAccount,
  updateProfile,
  changePassword,
  AccountNotFoundError,
  CurrentPasswordRequiredError,
  CurrentPasswordError,
  DuplicateAccountEmailError,
};
