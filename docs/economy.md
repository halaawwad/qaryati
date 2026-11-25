# Economy and agriculture

[OpenAPI](openapi/economy.yaml) documents all five endpoints. Agriculture uses the
existing CROP/LIVESTOCK categories. GET list/detail remain public. POST permits
EDITOR, REVIEWER and ADMIN and creates PENDING/version 1 with an active village/source.
POST requires name, category and sourceId; the server assigns the initial version.
Client-supplied version and other unknown/protected fields are rejected. Optional
description cannot be null on creation (PATCH permits null); isMajor defaults to false.

PATCH `/api/v1/economy/:id` requires integer version 1–2147483646 and at least one
editable field: name, category, sourceId, description, isMajor, asOfYear. Omitted
fields are preserved, including isMajor. Name is trimmed, nonblank, maximum 200;
description is trimmed, maximum 5000. Description/year may be cleared with null.
Year accepts signed PostgreSQL integers including zero. Source cannot be removed;
only a changed source ID is revalidated through SourceService. Unchanged deleted
sources do not block unrelated edits. Protected/unknown fields are rejected.

Editors may edit only their own PENDING records; reviewers/admins may edit any active
record. Existence, authorization, then version are checked in that order. The UPDATE
predicate includes ID, version, deletedAt and active parent. Successful edits, including
same-value edits, reset PENDING, increment version exactly once and set updatedById.
Stale writes return 409 VERSION_CONFLICT with the current version in details.

DELETE `/api/v1/economy/:id` requires ADMIN and has no request body. It preserves the row,
relationships and version, sets deletedAt/updater, and returns 204; repetitions return
404. The village is locked before the activity, whose audit snapshot is reread after
locking so a completed concurrent edit is included. Public reads exclude deleted
activities and parents. All verification statuses remain public; source deletion does
not hide activities. No name uniqueness constraint or new moderation route is added.

CREATE/UPDATE/DELETE each write one EconomicActivity audit through the existing
recordAudit service in the business transaction. UPDATE/DELETE include JSON-safe
before/after snapshots; deletion includes deletedAt. Audit failure rolls back the
business write. Public responses omit creator/updater IDs. No migrations are needed.

## Operation-specific errors

All writes return 401 for missing/invalid/expired bearer tokens, including unsupported
token roles. All currently supported roles may POST; PATCH adds the editor restrictions
above, and DELETE denies EDITOR/REVIEWER with 403 FORBIDDEN.

| Operation | 400 VALIDATION_ERROR | 404 NOT_FOUND | 409 VERSION_CONFLICT |
| --- | --- | --- | --- |
| POST | Invalid village UUID or strict creation body, including missing required fields | Missing/deleted village or source | Not used |
| PATCH | Invalid activity UUID or strict update body, including missing/invalid version or no editable fields | Missing/deleted activity, parent village or newly selected source | Stale version after existence and authorization checks |
| DELETE | Invalid activity UUID | Missing/deleted activity or parent village, including repeated deletion | Not used |

PATCH returns 403 CHANGE_REQUEST_REQUIRED for an editor's non-PENDING record, or
ECONOMY_EDIT_FORBIDDEN for a PENDING record owned by another user or with no creator.
Public GET operations do not require authentication or perform role checks.
Global JSON parsing can return 400 INVALID_JSON or 413 PAYLOAD_TOO_LARGE (over 1 MB)
when a JSON body is supplied, even on DELETE. Rate limiting can return 429; unexpected
database/audit failures return 500 with internal details hidden in production.

## Manual review examples

These are instructions for the reviewer; no manual requests were run by the agent.
Use a test database and Bearer access token for writes.

1. POST `/api/v1/villages/{{villageId}}/economy`:
   ```json
   { "name": "Olive farming", "category": "CROP", "sourceId": "{{sourceId}}" }
   ```
2. Save the returned ID/version. PATCH `/api/v1/economy/{{id}}`:
   ```json
   { "version": 1, "isMajor": true, "asOfYear": 2026 }
   ```
   Use the actual last-read version. Expect 200, version +1 and PENDING. Repeat with
   the old version: 409. Another editor: 403. Missing/invalid authentication: 401.
3. DELETE `/api/v1/economy/{{id}}` as ADMIN: 204. Repeat or GET detail: 404. The village
   list excludes it. EDITOR/REVIEWER deletion returns 403. Inspect exactly one audit
   per successful operation; failed requests must not persist changes or audits.

## Automated checks

Run `npm.cmd run typecheck`, `npm.cmd test -- --run`, `npm.cmd run build`, and
`git diff --check`. Existing GET/POST tests remain. Write tests exercise real routes,
middleware, services, repositories and audit code with mocked Prisma transactions.
They verify application rollback/race handling, not live PostgreSQL scheduling.
No external services, new dependencies or test database are needed.

## Disposable real-database API tests

Run `node scripts/test-economy-integration.mjs` with Docker available. The runner
creates uniquely labeled PostgreSQL 16 and Redis 7 containers with random ports
bound only to 127.0.0.1 and temporary in-memory storage. It applies existing Prisma
migrations, runs only `tests/integration/economy.postgres.integration.ts`, and removes
its containers in `finally`, including on test failures. No Compose services or
existing volumes are used. Image downloads may be needed on the first run.

Database/cache URLs and a generated signing secret are supplied only to child
processes. Before migrations, the runner verifies container labels, port bindings
and database identity. Before fixture writes or application imports, the tests
validate the run-specific URLs, database/user identity, and PostgreSQL/Redis markers.
Direct execution without this disposable environment fails closed.

The tests use Supertest against the real Express app, real Prisma transactions and
Redis rate limiting (production mode with quiet logs and a high rate limit). JWTs
are signed for synthetic database users; login itself is outside this suite's scope.
A database trigger deliberately rejects selected audit inserts to verify CREATE,
UPDATE and DELETE rollback without mocking the audit service. Concurrent HTTP PATCH
requests verify one successful versioned write and one conflict. Audit assertions
check actors, snapshots and counts, alongside authorization and public visibility.

Unknown token roles return 401 under the existing authentication contract. Valid
EDITOR/REVIEWER roles denied DELETE return 403. No authentication behavior changes.
The ordinary Vitest suite does not discover `.integration.ts` files; its safety-guard
unit tests run without Docker. The existing fixed-target integration suites are not
run by this runner. If the runner is forcibly killed or Docker becomes unavailable,
automatic cleanup cannot be guaranteed; it reports any cleanup failure and the exact
disposable container name. Never substitute the normal application database URL.
