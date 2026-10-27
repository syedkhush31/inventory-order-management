# Authentication

Status: implemented on both sides. The API provides login, logout and session check; the React app has a
login page, checks the session when it loads, and can sign out. Automated tests: unit tests with mocks, plus
one integration suite (`server/tests/integration/auth.integration.test.js`) that runs against the real
`inventory_test` database and **writes to it** (see the Testing section of the README). This document does not
record test results.

## Design
- **Accounts** live in the `admins` table. Only a bcrypt hash (cost 12, via `bcryptjs`) is stored.
  Passwords are limited to 72 bytes (the bcrypt limit); new passwords need at least 12 characters.
- **Login** `POST /api/auth/login`: input validated with zod, credentials checked, and a JWT (HS256,
  1 hour, no refresh token) is set in an **HttpOnly, SameSite=Lax cookie** (`Secure` in production).
  Unknown email, wrong password and deactivated account all return the same 401 message, and a dummy
  hash comparison keeps timing similar.
- **Logout** `POST /api/auth/logout` clears the cookie. **Me** `GET /api/auth/me` returns the current admin.
- **Protected routes** use `middleware/authenticate.js`. It verifies the token and re-checks the admin
  in the database, so deactivated admins lose access immediately.
- **CSRF**: besides SameSite=Lax, `middleware/requireSameOrigin.js` rejects state-changing requests whose
  `Origin` is not `CLIENT_ORIGIN` (or that the browser marks cross-site). CORS allows only that origin, with credentials.
- **Rate limiting**: 10 failed logins per 15 minutes per IP (successful logins are not counted).
- **Errors** are generic JSON; stack traces, SQL and secrets are never sent to clients.
- **Config**: `JWT_SECRET` must be at least 32 characters and not the example placeholder. The server
  refuses to start otherwise. It also refuses to start when `NODE_ENV` is `test` or any value other than
  `development` / `production` (unset counts as `development`), so a leftover `NODE_ENV=test` in a terminal
  cannot point the API at the test database.
- **Frontend**: the login page posts to `/api/auth/login` and then calls `GET /api/auth/me` to confirm the
  session before showing the app. The same check runs on every page load. A network or server error shows
  "cannot reach the server" instead of logging the user out. Any later `401` returns the user to the login
  page with a "session expired" notice. Sign out calls `/api/auth/logout`; if that request fails the user
  stays signed in and sees an error. The browser never stores the password or any token in
  `localStorage` or `sessionStorage`; the session lives only in the HttpOnly cookie.

## Creating the first administrator
Run `npm run admin:create` from `server/` in a real terminal. It asks for the email, then the password
twice at a hidden prompt, stores only the hash, and refuses to run if an admin already exists unless you
pass `--allow-additional`. No default administrator exists.

## Known limits / later options
No refresh tokens, no token revocation before expiry (logout only clears the cookie), no account lockout
beyond IP rate limiting. If deployed behind a proxy, configure Express `trust proxy` so rate limiting sees real IPs.
