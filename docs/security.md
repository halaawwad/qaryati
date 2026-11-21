# Security

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
