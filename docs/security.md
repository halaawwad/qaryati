# Security

## Security review (2026-11-23)

A final review of authentication, HTTP hardening, secrets, configuration and the Docker setup.
Each item lists what is in place, or a finding with its risk and the recommended fix.

### In place

| Area | Control | Where |
| --- | --- | --- |
| Passwords | bcrypt (`bcryptjs`) with cost 12; hashes never leave the auth module (`PublicUser` has no `passwordHash`) | `auth.service.ts` |
| Access tokens | JWT HS256 signed with `JWT_ACCESS_SECRET` (at least 32 characters, checked at startup), 15 minute lifetime | `auth.service.ts`, `config/env.ts` |
| Refresh tokens | 32 random bytes; only a SHA-256 hash is stored; rotated on every use; reusing a revoked token revokes all of that user's tokens; logout revokes the token | `auth.service.ts` |
| Registration | Always creates `EDITOR`; a `role` sent by the client is ignored. The first `ADMIN` comes from the seed (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`) | `auth.service.ts`, `prisma/seed.ts` |
| Login errors | Same `401 INVALID_CREDENTIALS` for an unknown email and a wrong password; inactive users get `403` only after a correct password | `auth.service.ts` |
| Authorization | `authenticate` + `requireRole(...)` on every write route; reads are public | `shared/middlewares` |
| Admin safety | An admin cannot change their own role or deactivate themselves (`CANNOT_MODIFY_SELF`), and the last active admin cannot be removed (`LAST_ADMIN`) | `users.service.ts` |
| Input validation | zod on params, query and body before any controller runs; unknown body fields are dropped or rejected | `validate.ts`, `*.schemas.ts` |
| SQL injection | Prisma query builder, and `$queryRaw` tagged templates (bind parameters) for raw SQL; no `$queryRawUnsafe` / `$executeRawUnsafe` anywhere | `src/` |
| HTTP headers | `helmet()` defaults (CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options`, HSTS, ...); `X-Powered-By` disabled | `app.ts` |
| Request size | JSON bodies limited to 1 MB (`413 PAYLOAD_TOO_LARGE`) | `app.ts` |
| Error responses | Unexpected errors return a generic `500 INTERNAL_ERROR`; stack traces only when `NODE_ENV=development` | `errorHandler.ts` |
| Logging | `Authorization` header redacted; request bodies (passwords, refresh tokens) are not logged; request logs carry the request ID | `app.ts` |
| Rate limiting | Global, login, register and refresh limits (details below) | `rateLimit.ts` |
| Secrets in Git | `.env` is git-ignored and has never been committed; `.env.example` holds placeholders only | `.gitignore` |
| Container | Multi-stage build; runtime has production dependencies only and runs as the non-root `node` user | `Dockerfile` |
| Dependencies | `npm audit` reviewed (details below) | `package-lock.json` |

### Findings

| # | Risk | Finding (as found in the review) | Fix | Status |
| --- | --- | --- | --- | --- |
| 1 | Medium | `docker-compose.yml` publishes Redis (no password) and PostgreSQL on all network interfaces (`6380`, `5433`). On a shared network, such as university Wi-Fi, other devices can reach them. | Ports are now bound to `127.0.0.1`, so only the local machine can connect. The containers still reach each other on the internal network. | Fixed |
| 2 | Medium | The `.env.example` placeholder `JWT_ACCESS_SECRET` is 42 characters, so it passes the 32 character check. A copied `.env` that keeps it signs tokens with a publicly known secret. | The app now refuses to start with the placeholder when `NODE_ENV=production`, and prints a warning in development and test. `.env.example` explains how to generate a secret: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. | Fixed |
| 3 | Low | Login skips `bcrypt.compare` for an unknown email, so it answers faster than for a known email with a wrong password. The response time reveals which emails are registered. Registration already reveals this through `409 EMAIL_TAKEN` (rate limited to 10 per hour per IP). | Login now compares against a fixed cost-12 dummy hash when the email is unknown, so both cases do the same bcrypt work. | Fixed |
| 4 | Low | `CORS_ORIGINS` defaults to `*` in `config/env.ts` and `docker-compose.yml`. Tokens are sent in the `Authorization` header, not cookies, so other sites cannot use a visitor's login, but any site can call the API from a browser. | Set the real frontend origin(s) in `CORS_ORIGINS` when deploying. This is deployment configuration, not code. | Open (deployment) |
| 5 | Low | `jwt.verify` does not pin the algorithm. `jsonwebtoken` 9 already rejects `none` and only allows HMAC algorithms for a string secret. | `jwt.verify` now passes `{ algorithms: ['HS256'] }`; tokens signed with HS384 or HS512 are rejected. | Fixed |
| 6 | Low | Passwords have a minimum length (8) but no maximum. bcrypt only uses the first 72 bytes, so two long passwords that share those bytes are treated as equal. | Registration now rejects passwords over 72 bytes (UTF-8, so Arabic letters count as 2 bytes). Login is unchanged so existing accounts still work. | Fixed |
| 7 | Accepted | Access tokens are stateless. After an admin deactivates a user or changes their role, the old access token keeps working until it expires (at most 15 minutes). Refresh already checks `isActive`. | Keep the 15 minute lifetime short. Checking the user on every request would add a database query to every protected call. | Accepted |

Re-run this review before each release and when authentication, the Docker setup or `.env` handling changes.

## Rate limiting

Rate limiting is enabled by default on `/api/v1`. Limits are configured through environment variables and shared across app instances using the existing Redis client:

| Limiter | Key | Window variable (default minutes) | Maximum variable (default) |
| --- | --- | --- | --- |
| Global | Client IP | `RATE_LIMIT_WINDOW_MINUTES` (15) | `RATE_LIMIT_MAX` (300) |
| `POST /auth/login` | Client IP + SHA-256 of normalized email | `LOGIN_RATE_LIMIT_WINDOW_MINUTES` (15) | `LOGIN_RATE_LIMIT_MAX` (5) |
| `POST /auth/register` | Client IP | `REGISTER_RATE_LIMIT_WINDOW_MINUTES` (60) | `REGISTER_RATE_LIMIT_MAX` (10) |
| `POST /auth/refresh` | Client IP | `REFRESH_RATE_LIMIT_WINDOW_MINUTES` (15) | `REFRESH_RATE_LIMIT_MAX` (30) |

All paths above are under `/api/v1`. Auth requests also count toward the global limit. `GET /api/v1/health` is always excluded from the limiter, including when the global quota is exhausted.

The login key combines the IP with a SHA-256 hash of the trimmed, lowercased email, so failed attempts for one account do not consume another account's login quota on the same IP. Raw emails are never stored in Redis keys. IPv6 addresses use the library's default /56 grouping to prevent bypass by rotating addresses within a subnet.
Login uses `skipSuccessfulRequests: true`: 2xx responses are removed from the count after completion; failures, including 401 and 403, count. In-flight requests temporarily count until their responses complete. Successful logins still consume the global quota.

Exhausted quotas return 429 in the unified error envelope with code `TOO_MANY_REQUESTS`, `Retry-After`, and standard `RateLimit` / `RateLimit-Policy` headers.
Redis keys use distinct `rl:global:`, `rl:login:`, `rl:register:`, and `rl:refresh:` prefixes. Counters survive app restarts and apply across app instances sharing the same Redis database. Redis itself must retain its data to preserve counters across Redis restarts.

If the rate-limit store fails, `passOnStoreError: true` allows requests and emits a warning without emails, passwords, derived keys, or store error details. Failed post-response login decrements also warn without crashing the app. This chooses availability over strict rate limiting: quotas may be exceeded while Redis is unavailable. The health endpoint still reports dependency health normally.

`TRUST_PROXY` defaults to `false`; Express then uses the socket address. Set it to `true` only when all traffic reaches the app through a trusted reverse proxy that overwrites forwarded headers and prevents direct access to the app. Express then derives the client IP from `X-Forwarded-For`. Allowing clients to supply trusted forwarding headers lets them evade IP quotas.

Set `RATE_LIMIT_ENABLED=false` for k6/load tests that send many requests from one IP. This disables every limiter, including the auth limiters, without creating rate-limit stores. Restore `true` for normal operation. Booleans accept only `true` or `false`; window lengths and maxima must be positive integers (windows are capped at Node's timer limit).

Tests use isolated in-memory stores and require no Redis connection.

## Dependency audit (npm audit)

Fixed:
- body-parser (via Express): DoS with compressed request bodies, updated with `npm audit fix`.
- zod: memory exhaustion on oversized collections, updated from 4.6.5 to 4.6.7.

Accepted (not fixed):
- prisma → @prisma/config → deepmerge-ts and effect (4 high findings).
- The only available fix is upgrading to Prisma 7, a breaking change; we deliberately pin Prisma 6.
- These packages run only when the Prisma CLI loads our own configuration (e.g. `prisma migrate deploy` at container start). They never process user input, so the vulnerable code paths are not reachable by API clients.
- Re-evaluate when upgrading Prisma.

Never run `npm audit fix --force`: it upgrades major versions (including Prisma) without review.
