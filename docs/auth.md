# Authentication

## Flow

Users register with email, password, and full name. New registrations always receive the `EDITOR` role.
Login returns a short-lived JWT access token and an opaque refresh token.
Authenticated requests use `Authorization: Bearer <accessToken>`.

## Token Lifetimes

Access tokens use HS256 and default to `15m` via `JWT_ACCESS_TTL`.
Refresh tokens default to 7 days via `JWT_REFRESH_TTL_DAYS`.
Refresh tokens are random opaque values; only their SHA-256 hashes are stored.

## Refresh Rotation

Each refresh request atomically revokes the presented refresh token and creates a replacement.
Reusing an already revoked refresh token is treated as reuse detection: all refresh tokens for that user are revoked and the request returns 401.

## Roles

Access tokens carry the user id and role. Route guards can use `requireRole(...roles)` after `authenticate`.

## Stateless Authenticate

`authenticate` verifies the JWT only and does not query the database on every request.
Inactive users are blocked at login and refresh. If a user is deactivated after an access token is issued, that token can remain valid until it expires; access tokens are short-lived to limit that window.

## User management

All endpoints below require a Bearer access token and the `ADMIN` role (401 without authentication, 403 for other roles):

- `GET /api/v1/users`: paginated `{data, meta}` with `page`, `limit` (capped at 100), `role`, `isActive=true|false`, and `q` (case-insensitive email/fullName search). Sorting uses `sort=createdAt|email|fullName` and `order=asc|desc`, defaulting to `createdAt` descending.
- `GET /api/v1/users/:id`: user details; unknown users return 404 `USER_NOT_FOUND`.
- `PATCH /api/v1/users/:id/role` with `{role}`: change role.
- `PATCH /api/v1/users/:id/status` with `{isActive}`: activate or deactivate.

User responses contain only `id`, `email`, `fullName`, `role`, `isActive`, `createdAt`, and `updatedAt`. Updates also return 404 `USER_NOT_FOUND` for unknown users.
Admins cannot change their own role or deactivate themselves (409 `CANNOT_MODIFY_SELF`). Same-value requests, including self requests, succeed with 200.
Demoting or deactivating the last active admin returns 409 `LAST_ADMIN`. The check and update run in one Serializable transaction, retried on Prisma P2034 conflicts for up to three total attempts.
Deactivation revokes all of the user's refresh tokens in the same transaction: subsequent login returns 403 and revoked-token refresh returns 401.
Existing access tokens remain valid until expiry, for at most `JWT_ACCESS_TTL` after deactivation.
Role changes take effect in newly issued access tokens at the user's next refresh/login, where the role is read from the database; existing access tokens retain their previous role until expiry.
