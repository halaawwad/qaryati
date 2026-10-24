import { describe, it } from 'vitest';

// Future behavior specifications only: these TODOs do not validate POST functionality.
// Dependency signatures and source error policy await the agreed shared architecture.
// Existing strict Zod validation remains authoritative for rejecting protected fields.
describe('LandmarkService.create — future specifications', () => {
  it.todo('creates a landmark with valid required fields for the village identified by the URL');
  it.todo('sets creator identity from the authenticated actor');
  it.todo('creates the landmark with PENDING status and version 1');
  it.todo('returns the standard village 404 for a missing village without insertion or audit');
  it.todo('returns the standard village 404 for a soft-deleted village without insertion or audit');
  it.todo('rejects a missing source without insertion or audit');
  it.todo('rejects a soft-deleted source without insertion or audit');
  it.todo('propagates a source lookup failure without insertion or audit');
  it.todo('propagates an insert failure without recording an audit');
  it.todo('creates the landmark and records its audit within one Prisma transaction');
  it.todo('propagates audit failure and rolls back creation while preserving previously committed records');
  it.todo('awaits audit completion and transaction commit before reporting success');
  it.todo('creates a landmark when all optional fields are omitted');
  it.todo('creates a landmark with both coordinates null and optional text fields omitted');
});
