# Authentication and account security

This document describes how sign-in, sessions and account changes work in ShelfSync, and what protects them. It reflects
the code in `server/src` (`services/authService.js`, `services/accountService.js`, `middleware/`, `routes/authRoutes.js`,
`routes/accountRoutes.js`, `utils/sessionCookie.js`) and `client/src/auth/AuthContext.jsx`.

Automated tests are mostly unit tests with mocks. One integration suite (`server/tests/integration/auth.integration.test.js`)
runs against the real `inventory_test` database and **writes to it** (see the Testing section of the README). This document
does not record test results.

## Overview

- There is one kind of user: an **administrator**, stored in the `admins` table. Every API route except sign-in and sign-out
  requires a valid session.
- A session is a **JSON Web Token (JWT)** kept in an **HttpOnly cookie** named `admin_token`. The browser's JavaScript cannot
  read it, and the app never puts a token or password in `localStorage`, `sessionStorage`, the URL or the console.
- The server does not keep a session table. Each request is checked by verifying the token **and** re-reading the
  administrator from the database.

## Accounts and passwords

- Passwords are stored only as **bcrypt** hashes (cost 12, via `bcryptjs`). Plaintext passwords are never stored or logged,
  and no response ever contains a password or a hash.
- bcrypt only uses the first 72 bytes of a password, so anything longer is rejected (72 **bytes**, not characters).
- A new password (when creating an administrator or changing the password) must be **at least 12 characters**. At sign-in
  any non-empty password up to 72 bytes is accepted for checking.
- Emails are trimmed, lower-cased and validated, up to 255 characters, and are unique (a database unique key decides).
- **No default administrator exists.** Create the first one with `npm run admin:create` from `server/` in a real terminal.
  The password is typed twice at a hidden prompt, only the hash is stored, and the script refuses to run against anything
  but `inventory_dev` or to add a second administrator unless you pass `--allow-additional`.

## Signing in and out

**`POST /api/auth/login`** `{ email, password }`
1. The input is validated with zod (`400` with the names of the invalid fields otherwise).
2. The administrator is looked up and the password is compared with bcrypt. When the email is unknown, a throwaway hash is
   compared instead, so an unknown email takes about as long to reject as a wrong password. (The throwaway hash is created
   on first use, so the very first such attempt after a server start is a little slower.)
3. An unknown email, a wrong password and a **deactivated** account all return the same `401 { "error": "Invalid email or password" }`.
4. On success the server sets the cookie and returns `{ admin: { id, email } }`. The session version is never sent to the client.

**`POST /api/auth/logout`** clears the cookie in that browser. **`GET /api/auth/me`** returns the current administrator
for a valid session, otherwise `401`. All three auth routes are sent with `Cache-Control: no-store`.

## The session cookie

| Property | Value |
|---|---|
| Name | `admin_token` |
| `HttpOnly` | Yes: scripts cannot read it |
| `SameSite` | `Lax` |
| `Secure` | Only when `NODE_ENV=production` (so plain `http://localhost` works in development) |
| Path | `/` |
| Lifetime | 1 hour (`maxAge`), matching the token's expiry. There is **no refresh token**: after an hour you sign in again |

Login, logout and password change all build the cookie from one function (`utils/sessionCookie.js`), so the settings always match.

## The token and token_version

- The JWT is signed with **HS256** using `JWT_SECRET`. Verification only accepts HS256, which blocks algorithm-confusion tricks.
- Its subject (`sub`) is the administrator's id, and it carries a **`tv`** claim: the administrator's `token_version` at sign-in.
- `JWT_SECRET` must be at least 32 characters and must not be the example placeholder. The server refuses to start otherwise,
  and the error message never contains the secret.
- `admins.token_version` starts at 0 and **goes up by one on every password change**.
- On every protected request (`middleware/authenticate.js`) the server verifies the token, then loads the administrator and
  requires **all** of these:
  1. the administrator exists,
  2. `is_active` is true, and
  3. the database `token_version` equals the token's `tv`.

  Otherwise the answer is `401 { "error": "Authentication required" }`.
- A token without a `tv` claim (from before the column existed) counts as version 0, as does a row without the column.
  A `tv` that is not a whole number from 0 up is invalid.

### What ends a session

| Event | Effect |
|---|---|
| The token expires (1 hour) | The next request returns `401`; the app returns to the sign-in page with a "session expired" notice |
| The administrator is **deactivated** or deleted | Access ends at once, even with a valid token |
| The **password is changed** | `token_version` rises, so every older cookie stops working immediately. The browser that made the change gets a fresh cookie and stays signed in |
| Sign out | Clears the cookie in that browser only. The token itself is **not revoked** and stays valid until it expires if someone copied it |
| Changing the display name or email | Does **not** end sessions |

## Password change flow

**`POST /api/account/password`** `{ currentPassword, newPassword }` (the administrator must be signed in)
1. Validation: `newPassword` at least 12 characters, at most 72 bytes, and different from `currentPassword`; unknown properties are rejected (`400` with field names).
2. The wrong-password limiter (below) is applied.
3. In **one database transaction** with the administrator's row locked: the current password is checked against the stored
   hash (`403 { "error": "Current password is incorrect" }` if wrong), the new hash is stored **and** `token_version` is raised
   in a single `UPDATE`, and an `ACCOUNT_PASSWORD_CHANGED` audit row is written (it stores no details at all).
4. The new version is read back inside the transaction and a **new cookie** is issued with it.
5. The response is `200 { "message": "Password changed. Other sessions have been signed out." }`.

A wrong current password is a `403`, not a `401`, because the person *is* signed in (a `401` would sign them out in the app).
After the change the Settings page asks the server who is signed in (`GET /api/auth/me`) to confirm the new cookie works.

## Account and profile APIs

All account routes require a signed-in administrator and act **only on that administrator's own account**: the id always
comes from the verified session, never from the URL or the body. Responses are `Cache-Control: no-store`.

| Route | Purpose |
|---|---|
| `GET /api/account` | `{ account: { id, email, displayName, createdAt } }`. Never the hash, the session version or the active flag |
| `PATCH /api/account/profile` | Change `displayName` (up to 100 characters, no control characters; `null` or `""` clears it) and/or `email`. Only these three properties are accepted: `displayName`, `email`, `currentPassword`. Anything else (`id`, `isActive`, `passwordHash`, `tokenVersion`, ...) is rejected with `400` |
| `POST /api/account/password` | Change the password (see above) |

Rules for `PATCH /api/account/profile`:
- **Changing the email requires `currentPassword`**: `400` if it is missing, `403` if it is wrong, `409` if another account
  already uses the email. A display-name-only edit never asks for the password.
- Only fields that really change are written. If nothing changes, nothing is written and nothing is audited (still `200`).
- The change and its `ACCOUNT_PROFILE_UPDATED` audit row (field **names** only, never the values) are saved in one transaction.
- If the account was deactivated in the meantime the answer is `401`.

## Rate limiting

Both limiters use `express-rate-limit` with in-memory counters.

| Limiter | Applies to | Limit | Counts |
|---|---|---|---|
| Login | `POST /api/auth/login` | 10 per 15 minutes **per IP address** | Failed attempts only; successful logins are not counted |
| Wrong current password | `POST /api/account/password` and `PATCH /api/account/profile` **when the email is being changed** | 5 per 15 minutes **per administrator** | Only a wrong current password (`403`). A success, a validation error or a duplicate email does not use up the allowance |

Over the limit the answer is `429` with a clear message and standard `RateLimit` headers. The second limiter exists so that
someone holding a stolen session cannot guess the password through these routes. See the limitations below.

## Other protections

- **CSRF.** On top of `SameSite=Lax`, `middleware/requireSameOrigin.js` rejects state-changing requests (anything but
  `GET`, `HEAD`, `OPTIONS`) with `403` when the `Origin` header is not exactly `CLIENT_ORIGIN`, or, when there is no `Origin`,
  when the browser marks the request cross-site through `Sec-Fetch-Site`. Requests with neither header (curl, Postman,
  tests) pass this check but still need the cookie.
- **CORS** allows only `CLIENT_ORIGIN`, with credentials.
- **Security headers** come from `helmet` (they apply to API responses; the host that serves the built client needs its own headers).
- **SQL injection.** All SQL uses `?` placeholders. Sort columns and editable columns come from fixed allow-lists, and `LIKE`
  search text is escaped.
- **Input validation.** Every body and query string is validated with zod; the request body is limited to 10 KB; unknown
  properties are rejected rather than ignored; lists are paginated with a maximum page size.
- **Errors.** Clients only see generic messages. Stack traces, SQL and secrets are never returned, and the server logs only a
  short error code.
- **Startup checks.** The API refuses to start with a missing database setting or `JWT_SECRET`, with an unsafe `JWT_SECRET`, or
  with `NODE_ENV=test` or any value other than `development` / `production`, so a leftover test setting cannot point the API at
  the test database.
- **Audit log privacy.** Account changes are recorded by field name only. Passwords, hashes, tokens and email addresses are
  never written to `audit_log`; its details are limited by strict allow-lists (see the README).
- **Dependencies.** Run `npm audit` in `server/` and `client/` before a release and review the result; this document does not record audit results.

## Frontend behaviour

- On every page load the app calls `GET /api/auth/me`. While it waits it shows "Checking your session"; if the server cannot be
  reached it shows "Cannot reach the server" with a retry button and does **not** treat that as being signed out.
- After sign-in the app calls `GET /api/auth/me` again to confirm the cookie really works (for example that the browser did not block it).
- Any later `401` from the API returns the user to the sign-in page with a "session expired" notice. A `403` (such as a wrong
  current password) does not.
- Every URL is protected: without a valid session the sign-in page is shown, and you return to the page you asked for after signing in.
- Sign out calls `/api/auth/logout`; if that request fails the user stays signed in and sees an error.
- The client-side checks (password length, matching confirmation) are only a convenience. The server enforces every rule again.

## Known limitations

- **No token revocation on sign-out.** Sign out only clears the browser's cookie. A copied token stays valid for up to an
  hour; only a password change or deactivating the account ends it earlier. There is no "sign out everywhere" button.
- **No refresh tokens** and no "remember me": sessions last one hour.
- **Rate limits are in memory.** They reset when the server restarts and are not shared between several server processes.
  There is no limit on other routes, and no account lockout beyond the IP limit on login and the per-administrator limit on
  wrong current passwords.
- **Reverse proxies.** Express's `trust proxy` setting is not configured. Behind a proxy the login limiter would see the
  proxy's address for every visitor, so one person's failures could block everyone (or the limit could be bypassed). Configure
  it before deploying behind a proxy.
- **`SameSite=Lax` cookie.** The web app and the API have to be served from the same site (for example behind one reverse
  proxy). A frontend and API on unrelated domains will not send the cookie.
- **Single role.** All administrators have the same powers. There are no roles, no email verification, no password reset by
  email and no multi-factor authentication. Changing the email does not verify the new address.
- **Passwords** are checked for length only, not against lists of common or breached passwords.
- **HTTPS is not provided** by the app. Run it behind HTTPS in production and set `NODE_ENV=production` so the cookie is `Secure`.
- The app has no deployment configuration, so none of this has been exercised in a hosted environment.
