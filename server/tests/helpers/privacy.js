// Checks that a response (or any stored value) does not leak secrets or personal data. Nothing here touches a database.
//
//   assertNoSecrets(res.body)                              no bcrypt hash, no JWT, no secret-looking property names
//   assertNoSecrets(res.body, ['Ann Example', 'secret'])   ...and none of these exact values appears anywhere in it
//
// Values to look for are passed in by the test (made-up markers); this file contains no real credentials.
const BCRYPT_HASH = /\$2[aby]\$\d{2}\$/;
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/;

// Property names that must never appear in an API response or in audit details.
const FORBIDDEN_KEYS = new Set(['password', 'passwordhash', 'password_hash', 'tokenversion', 'token_version', 'token', 'secret', 'jwt']);

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, keys));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      keys.push(key);
      collectKeys(inner, keys);
    }
  }
  return keys;
}

function assertNoSecrets(payload, forbiddenValues = []) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  expect(text).not.toMatch(BCRYPT_HASH);
  expect(text).not.toMatch(JWT_SHAPE);
  for (const value of forbiddenValues) {
    expect(text.includes(String(value))).toBe(false);
  }
  const badKeys = collectKeys(payload).filter((key) => FORBIDDEN_KEYS.has(key.toLowerCase()));
  expect(badKeys).toEqual([]);
}

module.exports = { assertNoSecrets, BCRYPT_HASH, JWT_SHAPE, FORBIDDEN_KEYS };
