# Facilities

[OpenAPI](openapi/facilities.yaml) documents all five operations. Public reads include
all verification statuses and exclude facilities or villages with deletedAt set.
Source deletion does not hide a facility.

| Method and path | Permission | Result |
| --- | --- | --- |
| GET `/api/v1/villages/:villageId/facilities` | Public | Paginated list |
| GET `/api/v1/facilities/:id` | Public | Facility detail |
| POST `/api/v1/villages/:villageId/facilities` | EDITOR, REVIEWER, ADMIN | 201, PENDING, version 1 |
| PATCH `/api/v1/facilities/:id` | EDITOR owns PENDING record; REVIEWER/ADMIN any active record | 200, PENDING, version +1 |
| DELETE `/api/v1/facilities/:id` | ADMIN | 204, no response body |

POST requires name, facilityType and an active sourceId in an active village. Source
verification status is unrestricted. Client version is not accepted. Existing POST
behavior is preserved: numeric coordinates require both numbers; otherwise each
coordinate may be omitted or null. Description is optional but not nullable on POST.

PATCH requires integer version 1 through 2147483646 plus at least one editable field:
name, facilityType, sourceId, description, asOfYear, latitude, longitude. Strict Zod
validation rejects unknown/protected fields. Name is trimmed, nonblank, at most 200
characters; description is trimmed, at most 5000 characters. Description/asOfYear
can be cleared with null. Year accepts the full signed PostgreSQL integer range.
Source cannot be removed; only a changed sourceId is revalidated by SourceService.
An unchanged, now-deleted source does not block unrelated edits.

PATCH coordinates are an explicit pair: both numbers (latitude -90 to 90, longitude
-180 to 180), both null to clear, or both omitted to preserve. A single null is invalid,
as is mixing a number and null. Zero and boundary values are accepted. PostgreSQL
Decimal(9,6) rounds storage to six decimal places; HTTP and audit snapshots use the
persisted numeric values. Omitted fields are never replaced by defaults.

Existence, editor permissions, then version are checked in that order. Stale updates
return 409 VERSION_CONFLICT with the current version in details. Editors receive
403 FACILITY_EDIT_FORBIDDEN for another/no creator, or CHANGE_REQUEST_REQUIRED for
reviewed records. Unknown token roles return 401 under the shared authentication
contract. Valid EDITOR/REVIEWER tokens on DELETE return 403 FORBIDDEN.

Following [ADR-0005](adr/0005-optimistic-locking-and-audit.md), PATCH guards the actual
UPDATE by id/version/deletedAt and active parent, increments once, resets PENDING and
sets updatedById. DELETE has no request body or version precondition, preserves the
physical row/version, and sets deletedAt/updater. Repeated deletion returns 404.
Writes protect the parent through VillageService's transaction lock. DELETE locks
the facility after the parent and rereads it before recording its audit snapshot;
this includes an edit that committed while deletion waited. Two competing PATCHes
with the same version have one winner; concurrent delete/update either edits before
deletion or rejects the edit with 404.

CREATE/UPDATE/DELETE each use recordAudit with entityType `Facility` and the same
transaction client. UPDATE and DELETE include JSON-safe before/after snapshots,
actor and request ID; DELETE snapshots include deletedAt. Audit failures roll back
the business write. Rejected requests create no audit. Public responses omit actor
IDs and deletedAt. No migrations or additional business/audit repositories are needed.

## Automated verification

Run the regular checks:

```powershell
npm.cmd run typecheck
npm.cmd test -- --run
npm.cmd run build
git diff --check
```

Run real HTTP/database verification with Docker available:

```powershell
node scripts/test-facilities-integration.mjs
```

The standalone runner creates PostgreSQL 16 and Redis 7 with unique labels/names,
temporary storage and random 127.0.0.1 ports. It overrides connection URLs only in
child processes and checks container identity, port bindings and database/user identity
before applying existing migrations. Tests verify run-specific URLs and markers in
both PostgreSQL metadata and Redis before any fixture writes or application imports.
Normal project databases and Compose services are never used. No Economy or Landmarks
branch code is imported. Geo lookup is disabled and no external geocoding is called.

Supertest exercises the real app, repositories and transactions; signed tokens use
synthetic database users (login itself is outside this suite). Production-mode rate
limiting exercises Redis. A disposable database trigger rejects selected audit inserts
to verify rollback without mocking the audit service. Expected Prisma error logs in
these cases are intentional. Concurrency tests cover competing updates, edit/delete
and repeated deletion. Schema and safety-guard tests also run without Docker.

The runner cleans up its containers in finally, including test failures. A forced
process kill or unavailable Docker can prevent cleanup; any detected cleanup failure
reports the exact disposable container name. Initial image downloads may be required.
The ordinary suite excludes `.integration.ts` files; the runner selects only Facilities
and does not execute the older integration suites that target fixed local databases.

Validate OpenAPI with `npm.cmd exec --yes --package=@apidevtools/swagger-cli -- swagger-cli validate docs/openapi/facilities.yaml`.
