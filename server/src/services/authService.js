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

// Returns { id, email } for valid credentials of an active admin, otherwise null.
async function verifyCredentials(email, password) {
  const admin = await adminRepository.findByEmail(email);
  const hash = admin ? admin.password_hash : await getDummyHash();
  const passwordMatches = await bcrypt.compare(password, hash);
  if (!admin || !passwordMatches || !admin.is_active) {
    return null;
  }
  return { id: admin.id, email: admin.email };
}

function signToken(admin) {
  env.assertAuthConfig();
  return jwt.sign({}, env.jwt.secret, {
    algorithm: JWT_ALGORITHM,
    subject: String(admin.id),
    expiresIn: env.jwt.expiresInSeconds,
  });
}

// Returns the admin id stored in a valid, unexpired token, otherwise null.
function verifyToken(token) {
  env.assertAuthConfig();
  try {
    const payload = jwt.verify(token, env.jwt.secret, { algorithms: [JWT_ALGORITHM] });
    return /^\d+$/.test(String(payload.sub)) ? Number(payload.sub) : null;
  } catch (err) {
    return null;
  }
}

// Looks the admin up again so deactivated or deleted accounts lose access immediately.
async function getActiveAdmin(id) {
  const admin = await adminRepository.findById(id);
  if (!admin || !admin.is_active) {
    return null;
  }
  return { id: admin.id, email: admin.email };
}

module.exports = { hashPassword, verifyCredentials, signToken, verifyToken, getActiveAdmin };
