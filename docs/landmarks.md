# Landmarks

The module follows Routes → Controller → Service → Repository. See
[OpenAPI](openapi/landmarks.yaml) for complete schemas and responses.

| Method and path (under `/api/v1`) | Access | Success |
| --- | --- | --- |
| GET `/villages/:villageId/landmarks` | Public | 200 `{data: [], meta: {...}}` |
| GET `/landmarks/:id` | Public | 200 `{data: {...}}` |
| POST `/villages/:villageId/landmarks` | EDITOR, REVIEWER, ADMIN | 201 `{data: {...}}` |
| PATCH `/landmarks/:id` | EDITOR owns PENDING record; REVIEWER/ADMIN any active record | 200 `{data: {...}}` |
| DELETE `/landmarks/:id` | ADMIN | 204, empty body |

Reads include all verification statuses, but exclude deleted landmarks and landmarks
whose village is deleted. Lists support `search` (case-insensitive Arabic/English
name contains), `landmarkType`, `verificationStatus`, `page`, `limit`, `sort`
(`nameAr`, `nameEn`, `createdAt`) and `order` (`asc`, `desc`). Defaults are page 1,
limit 20 (maximum 100), nameAr ascending; ID is the stable tie-breaker and null
English names sort last. Unknown query keys are ignored. Search retains the existing
PostgreSQL pattern behavior (`%` and `_` are wildcards). Empty/out-of-range pages
return 200; a missing/deleted parent is 404. Deleting a source does not hide landmarks.

## Writes and domain rules

POST requires trimmed nonblank `nameAr` (maximum 200), `landmarkType` and an active
`sourceId` UUID. The village must exist and be active. Optional fields are `nameEn`
(nonblank, maximum 200), `description` (maximum 5000), and coordinates. Latitude is
between -90 and 90; longitude between -180 and 180. Both must be numeric together;
creation also permits either coordinate to be omitted/null when neither is numeric.
New records start PENDING at version 1. Sources of any verification status are usable.

PATCH requires numeric integer `version` from 1 through 2147483646 and at least one
of `nameAr`, `nameEn`, `landmarkType`, `description`, `latitude`, `longitude`, `sourceId`.
Text lengths and numeric ranges match creation. `nameEn` and `description` may be
cleared with null. Coordinates must both be supplied as numbers or both null; omit
both to retain them. A source may be replaced with an active UUID but not removed.
An unchanged source is not revalidated, so unrelated edits remain possible after its
deletion. Fields omitted from PATCH are preserved.

Unknown/protected body fields are rejected: clients cannot set IDs, villageId,
creator/updater, timestamps, deletion or verification status. Editors may edit only
their own PENDING landmarks; REVIEWER and ADMIN may edit reviewed records or records
with another/no creator, following the existing village edit policy. Every accepted
edit, including same-value edits, increments version and resets status to PENDING.
There are no Landmark-specific verify/reject endpoints in the existing specification;
this change does not invent them or change moderation elsewhere.

The guarded update matches ID, version, active landmark and active parent. Stale
writes return 409 `VERSION_CONFLICT` with the current version in error details.
Village/source locks protect references during the transaction. Soft deletion records
`deletedAt` and updater, retains version and relationships, and returns 404 on repeats.
A row lock makes the deletion audit snapshot reflect any edit that completed first.
CREATE/UPDATE/DELETE audits share the business transaction; audit failure rolls back
the write. Responses omit creator/updater IDs. No schema or migration is needed.
There is no landmark-name unique constraint; same-name landmarks remain allowed.

Errors use `{error: {code, message, details, requestId}}`: 400 for validation, 401 for
missing/invalid tokens, 403 for roles/ownership/review restrictions, 404 for inactive
or missing references, 409 for stale versions, 413 for oversized JSON, 429 for rate
limits and generic 500 for unexpected failures. Authentication/role guards precede
route validation. On PATCH, existence precedes ownership/status checks, then version.

## Postman walkthrough

Use an isolated development/test database and existing active village/source UUIDs.
Set `baseUrl` to the server origin (no `/api/v1`), `villageId`, `sourceId`, and an
access token from the existing login API. Writes use Authorization → Bearer Token.

1. POST `{{baseUrl}}/api/v1/villages/{{villageId}}/landmarks` with JSON:
   ```json
   { "nameAr": "عين البلد", "landmarkType": "SPRING", "sourceId": "{{sourceId}}" }
   ```
   Expect 201; save `data.id` as `landmarkId` and retain `data.version`.
2. GET `{{baseUrl}}/api/v1/landmarks/{{landmarkId}}` and
   `{{baseUrl}}/api/v1/villages/{{villageId}}/landmarks?landmarkType=SPRING&limit=5`.
   Expect 200 with numeric/null coordinates and pagination on the list.
3. PATCH `{{baseUrl}}/api/v1/landmarks/{{landmarkId}}` as its editor or a reviewer/admin:
   ```json
   { "version": 1, "nameEn": "Village Spring", "description": "Updated documentation." }
   ```
   Use the actual last-read version. Expect 200 and an incremented version. Repeat
   the same request with the old version: expect 409. Read again before retrying.
4. Try PATCH without a token (401), as a different editor (403), or with
   `verificationStatus`/a lone latitude (400). Existing reviewed records reject editor
   PATCH with `CHANGE_REQUEST_REQUIRED`; no test setup should alter production data.
5. DELETE `{{baseUrl}}/api/v1/landmarks/{{landmarkId}}` as ADMIN, with no body: 204.
   Other roles receive 403. Repeat DELETE and GET the detail: 404; list excludes it.
6. Review audit entries for the actor, request ID, before/after and action. No write
   or audit should persist for validation, authorization or version failures.

## Automated checks

Run `npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run build`, and
`git diff --check`. Landmark tests mock Prisma/transactions and use Supertest with
the real routes, authentication, validation, service and repository. They require no
database/Redis/network access and do not modify records. Transaction/race mocks
verify application wiring and guarded query shapes, not live PostgreSQL scheduling.
