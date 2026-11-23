# ADR-0004: Short-lived JWT access tokens with rotating opaque refresh tokens

## Status
Accepted (team decision, October 2026)

## Context
Authentication and authorization are mandatory. The API is stateless REST, used
by any client (a future web or mobile front end, or tools such as API-Dog).
Every write route must know who the caller is and which role they have
(`EDITOR`, `REVIEWER`, `ADMIN`), and the course asks us to justify password
handling and token lifetime.

We need fast checks on every request, a way to end sessions (logout,
deactivation), and protection if a token is stolen.

## Decision
- **Access token:** a JWT (HS256) carrying the user id and role, valid for
  15 minutes by default (`JWT_ACCESS_TTL`). It is sent as
  `Authorization: Bearer <token>`.
- **Refresh token:** a random opaque value valid for 7 days by default
  (`JWT_REFRESH_TTL_DAYS`). Only its SHA-256 hash is stored in
  `refresh_tokens`; the plain value is never persisted or logged.
- **Rotation:** every refresh revokes the presented token and issues a new
  pair, atomically. Two concurrent refreshes with the same token cannot both
  succeed.
- **Reuse detection:** if an already revoked refresh token is used again, all
  of that user's refresh tokens are revoked and the request returns 401. The
  revocation is committed outside the failing transaction so it is not rolled
  back.
- **Stateless `authenticate`:** the middleware verifies the JWT signature and
  expiry only; it does not query the database on every request.
  `requireRole(...roles)` checks the role from the token.
- **Passwords:** bcrypt (bcryptjs) with cost 12. Login returns the same 401
  `INVALID_CREDENTIALS` for an unknown email and a wrong password.
- **Registration** always creates `EDITOR`; the role is never taken from the
  request body. Admins change roles through the user management API.
- **Deactivated users** cannot log in or refresh (403), and deactivation
  revokes their refresh tokens.
- Login, registration and refresh are rate limited (see `docs/security.md`).

## Alternatives considered
- **Server-side sessions (session id in Redis or the database):** easy to
  revoke immediately, but every request needs a store lookup, and the API
  would depend on cookie handling for non-browser clients.
- **A single long-lived JWT:** simplest, but a stolen token would work for days
  and could not be revoked.
- **Checking the database in `authenticate` on every request:** immediate
  effect of deactivation and role changes, at the cost of one query per
  request. Rejected in favour of a short access-token lifetime.
- **Storing refresh tokens with bcrypt:** unnecessary. Refresh tokens are long
  random values that cannot be guessed, and SHA-256 allows a direct indexed
  lookup.

## Consequences
- Request authentication is fast and needs no database access.
- Logout and deactivation stop refresh immediately, but an already issued
  access token stays valid until it expires (at most 15 minutes by default).
  Role changes apply at the user's next refresh or login.
- A leaked database does not reveal passwords or usable refresh tokens.
- A stolen refresh token is detected the first time either party uses a token
  that was already rotated, and all of the user's sessions are ended.
- `JWT_ACCESS_SECRET` must be a long random secret kept out of the repository;
  changing it invalidates all access tokens.
