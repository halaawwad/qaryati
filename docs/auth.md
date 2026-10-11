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
