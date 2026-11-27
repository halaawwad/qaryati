# Heritage

[OpenAPI](openapi/heritage.yaml) documents all five supported operations.

| Method and path | Permission | Result |
| --- | --- | --- |
| GET `/api/v1/villages/:villageId/heritage` | Public | Paginated, filtered items |
| GET `/api/v1/heritage/:id` | Public | Item detail |
| POST `/api/v1/villages/:villageId/heritage` | EDITOR, REVIEWER, ADMIN | 201, PENDING, version 1 |
| PATCH `/api/v1/heritage/:id` | EDITOR owns PENDING record; REVIEWER/ADMIN any active record | 200, PENDING, version +1 |
| DELETE `/api/v1/heritage/:id` | ADMIN | 204, empty body |

## Model and validation

The existing Prisma HeritageItem model requires villageId, name and category.
HeritageCategory values are CRAFT, FOOD, AGRI_PRACTICE, CUSTOM and OTHER.
Description and sourceId are nullable. The model already includes status, version,
actor IDs, timestamps and deletedAt. There are no date/coordinate fields or name
uniqueness constraints. No migration is needed.

POST requires name and category; villageId comes from the path. Name is trimmed,
nonblank and at most 200 characters, following content input conventions. Description
is trimmed, at most 5000 characters, and may be empty or null. Category is a
case-sensitive enum, not free text. SourceId is optional/nullable; a supplied UUID
must identify an active source, regardless of verification status. The server assigns
actors, PENDING and version 1. Clients cannot supply a version on POST or set unknown
or protected fields (including villageId, actor IDs, status, timestamps and deletedAt).

PATCH requires integer version 1 through 2147483646 plus at least one editable field:
name, category, description or sourceId. Omitted fields are preserved. Only description
and sourceId can be cleared with null; name/category cannot. A changed non-null source
is revalidated through SourceService. Removing the source link is allowed; an unchanged
deleted source does not block unrelated edits.

Example create body: `{"name":"Basket weaving","category":"CRAFT"}`.
Example update body: `{"version":1,"description":"Traditional local craft"}`.
Use the version returned by the last read. DELETE has no request body.

## Permissions, transactions and audit

Existence, editor authorization, then version are checked in that order. Editors
receive 403 HERITAGE_EDIT_FORBIDDEN for another/no creator, or CHANGE_REQUEST_REQUIRED
for a non-PENDING item. Missing, invalid, expired or unsupported-role tokens return
401 under the shared authentication contract. EDITOR/REVIEWER deletion returns 403
FORBIDDEN. Invalid UUIDs, fields or bodies return 400 VALIDATION_ERROR; malformed JSON
returns INVALID_JSON. Missing/deleted items, villages or supplied sources return 404.

Following [ADR-0005](adr/0005-optimistic-locking-and-audit.md), PATCH guards the actual
database update by id/version/deletedAt and active parent. It increments once, resets
PENDING and sets updatedById, even for same-value edits. Stale writes return 409
VERSION_CONFLICT with current version details. DELETE preserves the physical row,
version and relationships, sets deletedAt/updater, and returns 404 on repetition.
Writes protect the parent through VillageService's shared transaction lock. DELETE
locks the heritage row after the parent, then rereads its audit snapshot to include
an edit that completed while it waited.

Each successful operation writes exactly one `HeritageItem` CREATE/UPDATE/DELETE
audit via recordAudit in the business transaction. Snapshots serialize timestamps;
UPDATE/DELETE include before/after, actor and request ID; DELETE includes deletedAt.
Audit failures roll back writes. Rejected operations produce no audit entries.
Public responses omit actor IDs and deletedAt.

## Existing reads

Public GET behavior is preserved: all verification statuses are visible, deleted
items and parents are excluded, and source deletion does not hide an item. Lists
retain search, category/status filters, sorting and pagination. ID is a stable sort
tie-breaker. An active village with no matches returns 200 with an empty page.

## Automated verification

```powershell
npm.cmd run typecheck
npm.cmd test -- --run
npm.cmd run build
node scripts/test-heritage-integration.mjs
git diff --check
npm.cmd exec --yes --package=@apidevtools/swagger-cli -- swagger-cli validate docs/openapi/heritage.yaml
```

The Heritage runner creates PostgreSQL 16 and Redis 7 with unique names/labels,
temporary storage and random 127.0.0.1 ports. It supplies fresh database/cache URLs
and a signing secret only to child processes. Before migrations it verifies container
identity, port bindings and database/user identity. Tests verify run-specific URLs
and markers in PostgreSQL metadata and Redis before writing fixtures or importing
the application. Only existing migrations run, only on the disposable database.
No Compose services, existing volumes, normal data or .env files are modified.
Geo lookup is disabled; no unmerged feature files are imported.

Supertest exercises real HTTP handlers, services, repositories, PostgreSQL transactions
and Redis rate limiting. Tokens are signed for synthetic users; login is outside the
suite's scope. A disposable database trigger rejects selected audit inserts to verify
CREATE/UPDATE/DELETE rollback without mocking the audit service. Expected Prisma error
logs for these tests are intentional. Concurrent requests test stale updates,
edit/delete and simultaneous deletion. Unit tests cover schemas, safety guards,
service conflict branches and repository write guards. Existing GET tests remain.

The ordinary suite excludes `.integration.ts`; the runner selects only Heritage and
does not run older fixed-database integration suites. Finally cleanup removes only
its containers after verifying their ownership labels, including on test failures.
A forced kill or unavailable Docker may prevent cleanup; detected failures report
the exact disposable container name. Initial image downloads may be required.
