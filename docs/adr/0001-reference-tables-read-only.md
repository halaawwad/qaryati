# ADR-0001: Reference tables are read-only and have no soft delete

## Status
Accepted (team decision, October 2026)

## Context
Content tables (villages, village_names, sources, population_records, ...) use
`deleted_at` for soft delete, so data is never lost and changes stay auditable.
Three tables do not have this column: `governorates`, `local_authorities`, and
`nearby_places`. We had to decide whether to add it or treat them differently.

## Decision
- `governorates` and `local_authorities` are reference data. The API exposes
  them read-only. They change only through the seed or a migration.
- `nearby_places` rows are relationships with nothing referencing them, so they
  may be hard-deleted, but every deletion must be written to `audit_logs`
  with the full `before` snapshot.
- Deleting a nearby relation requires REVIEWER or ADMIN, and the audit row keeps
  the full deleted row in `before`, so it can be restored.

## Consequences
- No migration needed; the API surface for these tables stays small.
- Village counts per governorate exclude soft-deleted villages, so a deleted
  village never shows up indirectly.
- If governorates ever need editing through the API (e.g. renaming
  "Tubas" to "Tubas and Northern Valleys"), we must revisit this decision and
  add auditing and soft delete first.
- A deleted nearby relation can still be recovered from its audit entry.
