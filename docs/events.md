# Historical Events

[OpenAPI](openapi/events.yaml) documents the five supported operations.

| Method and path | Permission | Result |
| --- | --- | --- |
| GET `/api/v1/villages/:villageId/events` | Public | Paginated, filtered events |
| GET `/api/v1/events/:id` | Public | Event detail |
| POST `/api/v1/villages/:villageId/events` | EDITOR, REVIEWER, ADMIN | 201, PENDING, version 1 |
| PATCH `/api/v1/events/:id` | EDITOR owns PENDING record; REVIEWER/ADMIN any active record | 200, PENDING, version +1 |
| DELETE `/api/v1/events/:id` | ADMIN | 204, empty body |

## Model and input rules

The existing Prisma HistoricalEvent model requires villageId and title. Description,
eventYear, eventDate, category and sourceId are nullable. It includes isApproximate
(default false), verificationStatus (default PENDING), version (default 1), actor IDs,
timestamps and deletedAt. Category is free text, not an enum. There is no historical
period field or unique-title constraint. No migration is needed.

POST takes title plus optional editable fields. The village comes from the path.
Title is trimmed, nonblank and at most 200 characters, following content input
conventions. Description is trimmed, at most 5000 characters, and may be empty.
Category is trimmed, nonblank when supplied, and at most 100 characters (matching
the existing category query limit). Use null to clear nullable fields. Source is
optional: a supplied non-null UUID must refer to an active source, regardless of
verification status. The server assigns actors, status and version; clients cannot
set these or any unknown fields. POST has no version precondition.

eventYear accepts signed PostgreSQL integers (-2147483648 through 2147483647),
including negative historical years and zero. It is independent of eventDate;
neither is inferred from the other and they need not agree. No new chronology or
historical-period policy is imposed. eventDate accepts a valid ISO date-time with
Z or numeric timezone offset, normalizing to UTC years 0001 through 9999; use
eventYear for BCE history. Date-only, timezone-less, invalid calendar dates and
unsupported UTC years return 400. Dates serialize in UTC at millisecond precision.

PATCH requires integer version 1 through 2147483646 and at least one editable field:
title, description, eventYear, eventDate, isApproximate, category or sourceId. It
preserves omitted fields, including isApproximate. Nullable fields can be cleared
with null. Only changed, non-null source references are revalidated. Removing a
source link is allowed; an unchanged deleted source does not block unrelated edits.

## Permissions, conflicts and audit

Existence, editor authorization, then version are checked in that order. Editors
receive 403 EVENT_EDIT_FORBIDDEN for another/no creator, or CHANGE_REQUEST_REQUIRED
for non-PENDING events. Missing, invalid, expired or unsupported-role tokens return
401 under the existing authentication contract. EDITOR/REVIEWER deletion returns
403 FORBIDDEN. Unknown/protected body fields and invalid types return 400
VALIDATION_ERROR; malformed JSON returns INVALID_JSON. Missing/deleted events,
villages or supplied source references return 404 NOT_FOUND.

Following [ADR-0005](adr/0005-optimistic-locking-and-audit.md), PATCH guards the
database UPDATE by ID, version, deletedAt and active parent. It increments once,
resets PENDING and records updatedById, even for same-value edits. Stale writes
return 409 VERSION_CONFLICT with current version details. DELETE takes no body or
version, preserves the physical row/version and sets deletedAt/updater. Repeated
deletion returns 404. Writes protect the village through VillageService's shared
transaction lock. DELETE locks the event after the village, then rereads its audit
snapshot to include any edit that completed while waiting.

Each successful write records exactly one `HistoricalEvent` CREATE/UPDATE/DELETE
audit via recordAudit in the same transaction. Snapshots serialize dates to JSON;
UPDATE/DELETE include before/after values and DELETE includes deletedAt. An audit
failure rolls back the business write. Failed requests create no audit entries.
Public responses omit actor IDs and deletedAt.

## Existing reads

GET behavior is preserved: all verification statuses are public; deleted events or
parents are excluded; source deletion does not hide events. Lists support search,
case-insensitive category matching, status, approximation flag, eventYear range,
sorting and pagination. Year bounds do not infer years from eventDate and exclude
null eventYear values. Nullable sort values appear last; ID supplies a stable
tie-breaker. An active village with no matches returns an empty 200 page.

## Automated verification

```powershell
npm.cmd run typecheck
npm.cmd test -- --run
npm.cmd run build
node scripts/test-events-integration.mjs
git diff --check
npm.cmd exec --yes --package=@apidevtools/swagger-cli -- swagger-cli validate docs/openapi/events.yaml
```

The Events runner creates uniquely named/labeled PostgreSQL 16 and Redis 7 containers
with temporary storage and random localhost-only ports. Connection URLs and a fresh
signing secret are passed only to child processes. Before migrations it checks
container labels, bindings and database/user identity. Tests verify run-specific
URLs and PostgreSQL/Redis markers before fixture writes or application imports.
Only existing migrations run, only on the disposable database. No Compose services,
normal databases, persistent volumes or .env files are modified. Geo lookup is disabled.
The runner imports no unmerged Facilities, Economy or Landmarks code.

Supertest uses the actual app, repositories, PostgreSQL transactions and Redis rate
limiting. JWTs are signed for synthetic users; login is outside this suite's scope.
A disposable database trigger rejects selected audit inserts to verify CREATE,
UPDATE and DELETE rollback; expected Prisma error logs are intentional. Concurrency
tests cover competing PATCH requests, edit/delete and simultaneous deletion. Unit
tests cover schema validation, conflict branches, audit snapshots and safety guards;
existing GET tests remain intact.

The ordinary suite excludes `.integration.ts`. The runner selects only Events and
does not run older fixed-database suites. Cleanup runs in finally, including test
failures, and only removes containers whose unique ownership label matches. A forced
kill or unavailable Docker can prevent cleanup; detected cleanup failures report
the exact disposable container. Initial image downloads may be needed.
