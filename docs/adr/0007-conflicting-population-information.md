# ADR-0007: Conflicting population information and reviewed source selection

## Status

Proposed for team review. This record distinguishes the implementation at
main commit `69e86fc` from later branch-only work; it does not accept this ADR.

- **Merged:** sourced Population CRUD, verification and rejection, preferred
  selection, the preferred uniqueness constraint, optimistic checks, and audit.
- **Implemented but unmerged:** preferred-default reads (`2306314`), version
  exhaustion protection (`8a1331c`), and Population
  Change Request submission, listing, detail and rejection (`436bc89`). These
  commits build on one another; their presence on a branch is not acceptance.
- **Implemented on the Change Requests branch, unmerged:** approval and owner
  withdrawal with the confirmed review lifecycle. Remaining details are below.

## Context

Sources can disagree because they use different census methods, dates,
boundaries, estimates or definitions. For illustration only, one source might
report 1,000 people for a village in a year and another 1,200 for the same
village and year. These are fictional figures, not demographic claims. The
system needs to attribute each figure, preserve alternatives, let people review
them and identify a preferred value when appropriate. Concurrent edits must not
silently overwrite a review, and changes must be traceable.

## Decision

The following describes the existing model and implementation. Confirmed team
policies are identified below; branch-only implementation remains subject to
review and merge.

### Sourced records and review (merged, with final-review corrections on this branch)

- Population records require a source and belong to a village. A composite
  unique key on village, reference year and source allows multiple sources for
  a year while preventing a second record for the same combination, including
  when the earlier row is soft-deleted. Different sourced figures remain
  available rather than overwriting one another.
- A partial unique index allows **at most one** preferred record per village
  and year. It does not require a preferred record and includes soft-deleted
  rows. Normal Population soft deletion clears the preferred flag.
- New records are `PENDING`, version 1 and not preferred. Editors may directly
  edit their own pending records; reviewers and administrators may edit pending
  or verified records. Direct editing of rejected records is denied. Currently
  editing a verified record preserves its status and verification metadata. This
  intentionally differs from ADR-0005: reset to PENDING applies to Villages;
  authorized direct Population and Sources edits preserve VERIFIED. A Population
  reference-year change clears preference without replacement; other edits preserve it.
- Reviewers and administrators can verify or reject a record. A status change
  increments its version; verification records the reviewer and time, while
  rejection clears that metadata and the preferred flag without replacement.
  VERIFY clears `needsReview`; verifying an already VERIFIED record with the flag
  set refreshes metadata, increments version and audits. If the flag is clear it
  is a no-op. REJECT preserves `needsReview`; repeated rejection is a no-op.
- On creation and a changed population value, anomaly detection compares the
  value with the non-deleted verified record for the village with the greatest
  reference year, breaking ties by ID. An update excludes the record being
  edited. A difference strictly greater than 50% of the baseline is flagged;
  exactly 50% is not. No baseline produces no new flag; an invalid non-positive
  baseline is flagged. An existing flag remains set on update.
- Population updates and review require `expectedVersion`; a stale version
  yields HTTP 409. Actual changes increment the version and are audited in the
  same transaction. An authorized matching no-op does not increment the version
  or create an audit entry. An administrator can soft-delete a record without an
  expected version or version increment; the row, attribution and key
  reservation remain, and the deletion is audited. A deleted source does not
  hide its existing Population records.

### Preferred selection and reads

Preferred selection lets a reviewer or administrator explicitly
select a verified record. The request supplies the target's expected version
and the expected identity and version of the current preferred record, or null
for an empty slot. A successful change demotes the previous record if present,
promotes the target, increments each changed version and audits each change in
one transaction. Selecting the existing preferred record with matching
expectations is a no-op. Selection does not establish that every year has a
preferred record.

The preferred-read branch returns preferred records by default. `includeAll=true`
returns both preference values; an explicit `isPreferred=true` or `false`
filters that flag, and combining it with `includeAll=true` is invalid. There is
no automatic fallback for a year without a preferred record. The read filter
does not independently require `VERIFIED`, so legacy preferred records of other
statuses can appear. Main currently returns all preference values by default.

The final-review branch adds a guard against incrementing a Population version
at the PostgreSQL integer maximum, returning a conflict for an actual change;
matching no-ops can still succeed. This protection is implemented on that
branch and its descendants, not on main.

### Change Requests (implemented on this branch, unmerged)

On the Change Requests branch an editor can submit a proposed Population edit
against a verified record at a matching `baseVersion`. The proposal must make
an actual change; a replacement source must be active. It does not alter the
Population record or reserve a preferred slot, and multiple pending requests
are possible. Editors can list and view their own requests; reviewers and
administrators can see all. A reviewer or administrator can reject a pending
request with a comment; rejection records the reviewer and time, is audited
atomically and does not modify Population. Even a stale request or one whose
target was deleted can be rejected.

Approval applies the proposal atomically with its Population UPDATE and Change
Request APPROVE audits. It is a new verification: the approver and a single
approval time are recorded on both records, needsReview becomes false, and an
actual year change clears preference without replacement. Self-approval is
prohibited for all roles. Stale or exhausted versions conflict; other pending
proposals are not automatically superseded.

The confirmed policy permits an EDITOR to withdraw their own pending request.
As an implementation choice, the owner-only endpoint stores REJECTED with the
owner and time in review metadata and the comment Withdrawn by requester. Its
REJECT audit after snapshot includes withdrawn=true, distinguishing it from
reviewer rejection. A locked guarded transition and audit share a transaction;
the target need not be active or current. Reviewers and administrators may
reject, including their own requests.

## Alternatives considered

These are trade-offs for review, not claims of formal team rejection.

- **Store and overwrite one value:** simple reads and storage, but loses
  competing claims and their attribution unless separately preserved.
- **Automatically select the latest source:** simple and timely, but source
  date alone does not establish reliability or comparable methodology.
- **Automatically select by source priority:** consistent and scalable, but a
  fixed ranking may miss local context and requires governance of the ranking.
- **Keep sourced records and select explicitly:** preserves provenance and
  supports judgment, but creates reviewer work and may leave no preferred value.
- **Last write wins:** easy for clients, but can silently erase a concurrent
  edit or review. Expected versions instead require clients to resolve conflicts.

## Concurrency and consistency

[ADR-0005](0005-optimistic-locking-and-audit.md) explains the shared principles
of optimistic locking and same-transaction audit. Population uses its own
`expectedVersion` contract and guarded updates; this ADR does not assert that
its request or error details are identical to the Village API. Stale writes
receive HTTP 409, and clients must reload and decide how to proceed. Database
unique constraints provide the final guard against duplicate business keys.

A transaction-scoped advisory lock
serializes selection for a village/year, and affected rows are locked in
deterministic ID order. The target and prior slot are checked against expected
versions. The database partial unique index is the final preferred-slot guard,
including against writers that do not take that advisory lock. A concurrent
change or uniqueness conflict can result in HTTP 409.

Population mutation and audit writes share a transaction; if an audit write
fails, the mutation rolls back. The same pattern applies to preferred selection
and Change Request submission, approval, rejection and withdrawal. A checked no-op produces
neither a mutation nor an audit row. Audit rows are append-only by application
convention; database immutability is not enforced.

The anomaly baseline is selected at statement time inside the transaction. It
is not a durable snapshot of all future verified records and does not ensure a
flag is recalculated when a different record is later verified, edited or
deleted. Concurrent activity can therefore change the relevant baseline after
the check; the flag must not be treated as a globally current comparison.

## Consequences

- Attribution and retained alternatives make disagreements transparent and
  support review without silently discarding a source's claim.
- Human selection and review require time; a year can have no preferred record.
- Multiple rows, audit snapshots, locks and transactions add storage and
  implementation cost. Soft deletion preserves rows and key reservations;
  audit is not a database-enforced immutable history.
- Clients must handle 409 conflicts by re-reading and resolving their changes.
  If preferred-default reads are merged, existing clients expecting all records
  must explicitly request `includeAll=true` or an appropriate preference filter;
  years without a preferred record will disappear from the default list.

## Outstanding decisions

- Are additional Change Request lifecycle states or policy refinements needed
  beyond the implementation described here?

## References

- [ADR-0001: reference tables and soft deletion](0001-reference-tables-read-only.md),
  [ADR-0002: technology stack](0002-technology-stack.md),
  [ADR-0003: modular monolith](0003-modular-monolith.md), and
  [ADR-0005: optimistic locking and audit](0005-optimistic-locking-and-audit.md).
- Current tree: [Prisma schema](../../prisma/schema.prisma),
  [initial migration and indexes](../../prisma/migrations/20261010162836_init/migration.sql),
  [Population OpenAPI](../openapi/population.yaml),
  [Sources OpenAPI](../openapi/sources.yaml),
  [Population service](../../src/modules/population/population.service.ts),
  [repository](../../src/modules/population/population.repository.ts), and
  [Population review PostgreSQL tests](../../tests/integration/population.review.postgres.integration.ts).
- Merged preferred-selection commit `c2c2929`: [preferred selection service](https://github.com/halaawwad/qaryati/blob/c2c2929eaf8cc761d21fee525c139b3f2b924904/src/modules/population/population.service.ts),
  [repository and locks](https://github.com/halaawwad/qaryati/blob/c2c2929eaf8cc761d21fee525c139b3f2b924904/src/modules/population/population.repository.ts),
  and [PostgreSQL tests](https://github.com/halaawwad/qaryati/blob/c2c2929eaf8cc761d21fee525c139b3f2b924904/tests/integration/population.preferred.postgres.integration.ts).
- Unmerged commit `2306314`: [preferred reads OpenAPI](https://github.com/halaawwad/qaryati/blob/23063148effd6555d016aca5a84ad8e84fc6da48/docs/openapi/population.yaml)
  and [PostgreSQL tests](https://github.com/halaawwad/qaryati/blob/23063148effd6555d016aca5a84ad8e84fc6da48/tests/integration/population.read.postgres.integration.ts).
- Unmerged commit `8a1331c`: [version exhaustion implementation](https://github.com/halaawwad/qaryati/blob/8a1331cb58b8590717fb5b4de93ddb50d4915071/src/modules/population/population.service.ts)
  and [PostgreSQL tests](https://github.com/halaawwad/qaryati/blob/8a1331cb58b8590717fb5b4de93ddb50d4915071/tests/integration/population.preferred.postgres.integration.ts).
- Unmerged commit `436bc89`: [Change Requests OpenAPI](https://github.com/halaawwad/qaryati/blob/436bc8913bc64b511083d64280e9ebcddef0518b/docs/openapi/change-requests.yaml),
  [service](https://github.com/halaawwad/qaryati/blob/436bc8913bc64b511083d64280e9ebcddef0518b/src/modules/change-requests/change-requests.service.ts),
  and [rejection PostgreSQL tests](https://github.com/halaawwad/qaryati/blob/436bc8913bc64b511083d64280e9ebcddef0518b/tests/integration/change-requests.reject.postgres.integration.ts).
