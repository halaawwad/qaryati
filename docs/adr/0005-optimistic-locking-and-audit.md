# ADR-0005: Optimistic locking with a version column and same-transaction audit

## Status
Proposed (November 2026). Implemented in the village write endpoints (pull
request #31); it becomes Accepted when the team agrees.

## Context
Editors, reviewers and admins change the same villages. A reviewer verifies a
village while an editor is still editing the copy they loaded a minute ago.
Without a guard, the editor's save would silently overwrite the review, or the
other way round, and nobody would know. The project also promises that every
change to content is traceable: who changed what, when, from which request, and
what the row looked like before and after.

The API is stateless REST, so a client reads a record, thinks, and sends the
change in a later request. Nothing can hold a database lock across those two
requests. PostgreSQL runs at its default `READ COMMITTED` isolation, so two
requests can both read version 3 and both try to write.

We need to detect a conflicting change without locking anything for a long time,
and to be sure that a change and its audit record either both exist or neither
does.

## Decision
- **A `version` column** (integer, default 1) on the content tables that people
  edit, for example `villages` and `village_names`. The client sends the version
  it last read in the request body (`version`). A new row starts at 1.
- **The guard is in the `UPDATE` itself:**
  `updateMany({ where: { id, version, deletedAt: null },
  data: { ..., version: { increment: 1 } } })`.
  The statement changes the row only if it is still at the version the client
  saw. It returns the number of rows changed, so correctness does not depend on
  the isolation level. If it changes 0 rows, a fresh read tells the two reasons
  apart: the row is missing or deleted (404), or someone changed it (409
  `VERSION_CONFLICT`, with the current version in `details`).
- **A cheaper early check** reads the row inside the transaction and returns the
  409 before doing any other work when the version is already stale. The guarded
  `UPDATE` remains the real protection, for the race between that read and the
  write.
- **Every change bumps the version,** including `verify` and `reject`. An editor
  holding the old version gets a 409 instead of editing a village that was just
  reviewed. Any edit sends the record back to `PENDING` for review. A soft
  delete takes no version and does not increment it: a later write on a deleted
  record is a 404 anyway.
- **The change and its audit row share one transaction.** The repository exposes
  `transaction(fn)`, which gives `fn` a write repository and the transaction
  client. The service writes the change and then calls
  `recordAudit(input, tx)` from the audit module (through a small
  `VillageAuditRecorder` adapter, so tests can pass a fake). The audit row has
  the entity type and id, the action (`CREATE`, `UPDATE`, `DELETE`, `VERIFY`,
  `REJECT`), the actor, the request id, and JSON-safe `before` and `after`
  snapshots. If anything fails, both roll back; a rejected request (409, 422, ...)
  writes no audit row.
- **Writes that depend on a village lock it for the transaction:**
  `exists(id, tx)` runs `SELECT ... FOR SHARE` on the village row. Another
  request cannot soft-delete or change that village until the transaction ends,
  so a name or a nearby place cannot be attached to a village that disappears
  mid-request. Without a transaction client it is a plain check.
- **Unique constraints are the guard for duplicates** (slug, PCBS code, nearby
  pairs). The `P2002` error from the database is mapped to a 409 with a specific
  code, instead of a check-then-insert that would race.
- **Records that are never edited in place have no version.** A nearby place is
  created or removed; its removal is a hard delete whose audit row keeps the
  full row as `before`, so it can be restored from the log.

## Alternatives considered
- **Pessimistic locking (`SELECT ... FOR UPDATE` while a person edits):** it
  cannot span the two requests of a read-then-save flow without holding a
  transaction open for as long as someone thinks, and abandoned sessions would
  leave rows locked. Locking inside a single request only protects the short
  read-modify-write, not the stale copy in the client.
- **Last write wins:** the simplest option, but it silently loses edits and
  reviews, which is unacceptable for data whose value is that people verified
  it.
- **Audit after the commit** (or from a queue): the change could succeed and the
  audit row be lost if the process stops in between, or the audit write could
  fail after the change is already visible. Database triggers would keep both
  in one transaction but do not know the actor or the request id.
- **`updatedAt` as the version:** timestamps can collide or lose precision, and
  clients have to round-trip them exactly. An integer is simple to compare and
  to show in the error message.
- **An `If-Match` / `ETag` header instead of a body field:** the standard HTTP
  way, but harder to use from generic tools and clients, and no better at
  detecting the conflict. The same value could be exposed as an ETag later.

## Consequences
- Lost updates are impossible: a stale write is rejected, and the client
  reloads and retries. Clients must send `version` on every update, verify and
  reject, and handle 409 by re-reading the record.
- A reviewer and an editor can now conflict on purpose: after a `verify`, the
  editor's older version no longer matches. This is intended.
- Every write is one transaction with two inserts or updates (the change and
  the audit row), a little more work and latency per write.
- The audit table grows with every change, with full `before` and `after`
  snapshots. `recordAudit` stores only the fields it is given, so callers must
  pass safe snapshots (no secrets); decimals and dates are converted to JSON.
- `FOR SHARE` on the village row can briefly delay a concurrent deletion of that
  village while a dependent write is in progress.
- Rules that are only checked in code are still race-prone where the database
  has no matching constraint. The duplicate alternate-name check is the known
  case: two simultaneous requests can both pass it. Closing it needs a partial
  unique index on `village_names`, which is a schema change left for later.
- The same pattern (a `version` column, the guarded `updateMany`, and
  `recordAudit` in the same transaction) can be reused by the other modules that
  gain write endpoints.
