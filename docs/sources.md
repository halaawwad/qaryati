# Sources deletion

`DELETE /api/v1/sources/:id` requires a Bearer access token with the ADMIN role.
The ID must be a UUID. Send a JSON body containing only a positive integer
`expectedVersion`, matching the version returned by Sources reads. This follows
the PATCH precondition convention; clients cannot assign the next stored version.

```json
{ "expectedVersion": 3 }
```

Success returns HTTP 200 with a deletion receipt:

```json
{ "data": { "id": "22222222-2222-4222-8222-222222222222", "version": 4, "deletedAt": "2026-11-04T10:00:00.000Z" } }
```

The server sets `deletedAt`, increments `version` by one, and records the admin
in `updatedById`. ADMIN may delete active PENDING, VERIFIED, or REJECTED sources;
the temporary REJECTED restriction applies to direct PATCH editing only.
There is no physical deletion, restoration, or cascading change to related data.

Errors use the shared envelope and request ID: 400 for invalid input, 401 without
valid authentication, 403 for non-admin users, 404 NOT_FOUND for a source missing
or already deleted at the initial lookup, and 409 CONFLICT for a stale version or
a conditional update miss after that lookup (including a concurrent deletion).
Repeated deletion returns 404, even if the repeated expected version is stale.

The lookup, conditional soft-delete, and DELETE Audit insert share one Prisma
transaction. Audit failure rejects the transaction. Audit snapshots explicitly
select content/status/version fields and the deletion timestamp. URLs have their
credentials, complete query strings, and fragments removed; malformed or non-HTTP
legacy URLs become null in Audit only. No original URL is included in the receipt.

Source references from villages, village names, local authorities, population
records, events, landmarks, heritage, economic activities, and facilities remain
intact. Their foreign keys use `onDelete: Restrict`, and setting `deletedAt` does
not invoke physical-delete referential actions. Sources reads hide deleted rows.
Existing event, heritage, and landmark reads may still expose their retained
`sourceId`; village details suppress embedded deleted Source data. Soft deletion
does not hide or invalidate the referencing content automatically.

Mock tests verify calls, predicates, snapshots, and error propagation. They do
not verify actual PostgreSQL rollback, locking, or foreign-key behavior.
