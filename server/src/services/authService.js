// Password hashing, credential checking and JWT handling.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const adminRepository = require('../repositories/adminRepository');

const BCRYPT_COST = 12;
const JWT_ALGORITHM = 'HS256';

function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

// A throwaway hash compared against when the email is unknown, so a missing account
// takes about as long to reject as a wrong password (avoids revealing which emails exist).
let dummyHashPromise = null;
function getDummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = bcrypt.hash(crypto.randomBytes(16).toString('hex'), BCRYPT_COST);
  }
  return dummyHashPromise;
}

// The version of an admin's sessions. It starts at 0 and goes up by one on every password change. A database row (or
// an old row from before migration 003) without a version counts as 0.
function versionOf(row) {
  const version = Number(row.token_version ?? 0);
  return Number.isSafeInteger(version) && version >= 0 ? version : 0;
}

// Returns { id, email, tokenVersion } for valid credentials of an active admin, otherwise null.
async function verifyCredentials(email, password) {
  const admin = await adminRepository.findByEmail(email);
  const hash = admin ? admin.password_hash : await getDummyHash();
  const passwordMatches = await bcrypt.compare(password, hash);
  if (!admin || !passwordMatches || !admin.is_active) {
    return null;
  }
  return { id: admin.id, email: admin.email, tokenVersion: versionOf(admin) };
}

// admin: { id, tokenVersion }. The token carries the session version in the `tv` claim, so a password change (which
// raises the version in the database) makes every older token useless.
function signToken(admin) {
  env.assertAuthConfig();
  return jwt.sign({ tv: admin.tokenVersion ?? 0 }, env.jwt.secret, {
    algorithm: JWT_ALGORITHM,
    subject: String(admin.id),
    expiresIn: env.jwt.expiresInSeconds,
  });
}

// Returns { adminId, tokenVersion } from a valid, unexpired token, otherwise null.
// A token without a `tv` claim (issued before sessions had versions) is version 0. A `tv` that is not a whole number
// from 0 up is not valid.
function readToken(token) {
  env.assertAuthConfig();
  try {
    const payload = jwt.verify(token, env.jwt.secret, { algorithms: [JWT_ALGORITHM] });
    if (!/^\d+$/.test(String(payload.sub))) {
      return null;
    }
    const tokenVersion = payload.tv === undefined ? 0 : payload.tv;
    if (!Number.isSafeInteger(tokenVersion) || tokenVersion < 0) {
      return null;
    }
    return { adminId: Number(payload.sub), tokenVersion };
  } catch (err) {
    return null;
  }
}

// Returns the admin id stored in a valid, unexpired token, otherwise null.
function verifyToken(token) {
  const session = readToken(token);
  return session ? session.adminId : null;
}

// Looks the admin up again so deactivated or deleted accounts lose access immediately, and so a token whose version
// is no longer the admin's current version (the password was changed since) is refused.
async function getActiveAdmin(id, tokenVersion = 0) {
  const admin = await adminRepository.findById(id);
  if (!admin || !admin.is_active || versionOf(admin) !== tokenVersion) {
    return null;
  }
  return { id: admin.id, email: admin.email };
}

module.exports = { hashPassword, verifyCredentials, signToken, readToken, verifyToken, getActiveAdmin, versionOf };
