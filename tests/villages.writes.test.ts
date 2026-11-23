import { AuditAction, Prisma, Role, VerificationStatus, type Village } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VillageAuditEntry, VillageAuditRecorder } from '../src/modules/villages/villages.audit.js';
import type {
  VillageChanges,
  VillageCreateData,
  VillageDetails,
  VillageLookup,
  VillageRepository,
  VillageWriteData,
  VillageWriteRepository,
} from '../src/modules/villages/villages.repository.js';
import type { VillageService, WriteActor } from '../src/modules/villages/villages.service.js';
import { NotFoundError } from '../src/shared/errors.js';

const governorateA = '11111111-1111-4111-8111-111111111111';
const governorateB = '22222222-2222-4222-8222-222222222222';
const missingGovernorate = '33333333-3333-4333-8333-333333333333';
const authorityInA = '44444444-4444-4444-8444-444444444444';
const authorityInB = '55555555-5555-4555-8555-555555555555';
const sourceId = '66666666-6666-4666-8666-666666666666';
const missingVillageId = '99999999-9999-4999-8999-999999999999';

const editor: WriteActor = { userId: 'editor-1', role: Role.EDITOR, requestId: 'req-1' };
const otherEditor: WriteActor = { userId: 'editor-2', role: Role.EDITOR, requestId: 'req-3' };
const reviewer: WriteActor = { userId: 'reviewer-1', role: Role.REVIEWER, requestId: 'req-2' };
const admin: WriteActor = { userId: 'admin-1', role: Role.ADMIN, requestId: 'req-4' };
const fakeTx = { fake: 'tx' } as unknown as Prisma.TransactionClient;

function decimal(value: number | null | undefined): Prisma.Decimal | null {
  return value === null || value === undefined ? null : new Prisma.Decimal(value);
}

// Copies only the keys that are present, so `undefined` means "leave unchanged" like Prisma.
function applyWriteData(row: Village, data: VillageWriteData & { verificationStatus?: VerificationStatus }): void {
  const { latitude, longitude, areaDunums, ...plain } = data;
  for (const [key, value] of Object.entries(plain)) {
    if (value !== undefined) Object.assign(row, { [key]: value });
  }
  if (latitude !== undefined) row.latitude = decimal(latitude);
  if (longitude !== undefined) row.longitude = decimal(longitude);
  if (areaDunums !== undefined) row.areaDunums = decimal(areaDunums);
}

class FakeVillageStore implements VillageRepository, VillageWriteRepository {
  rows = new Map<string, Village>();
  governorates = new Set([governorateA, governorateB]);
  authorities = new Map([
    [authorityInA, governorateA],
    [authorityInB, governorateB],
  ]);
  sources = new Set([sourceId]);
  /** Runs right before updateIfVersion, to simulate a concurrent request. */
  beforeUpdate: (() => void) | undefined;
  createError: unknown;
  private nextId = 1;

  async transaction<T>(fn: (writes: VillageWriteRepository, tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return fn(this, fakeTx);
  }

  async findDetails(lookup: VillageLookup): Promise<VillageDetails | null> {
    const row = [...this.rows.values()].find((r) => ('id' in lookup ? r.id === lookup.id : r.slug === lookup.slug));
    if (!row || row.deletedAt) return null;

    return {
      ...row,
      latitude: row.latitude?.toNumber() ?? null,
      longitude: row.longitude?.toNumber() ?? null,
      areaDunums: row.areaDunums?.toNumber() ?? null,
      governorate: { id: row.governorateId, nameAr: 'محافظة', nameEn: 'Governorate', code: 'TST' },
      localAuthority: null,
      nameOriginSource: null,
      names: [],
    };
  }

  async findMany(): Promise<never> {
    throw new Error('not used');
  }

  async exists(): Promise<never> {
    throw new Error('not used');
  }

  async findLocation(): Promise<never> {
    throw new Error('not used');
  }

  async findNearbyPlaceRows(): Promise<never> {
    throw new Error('not used');
  }

  async findVillagesWithinRadius(): Promise<never> {
    throw new Error('not used');
  }

  async findById(id: string): Promise<Village | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async governorateExists(id: string): Promise<boolean> {
    return this.governorates.has(id);
  }

  async findLocalAuthorityGovernorateId(id: string): Promise<string | null> {
    return this.authorities.get(id) ?? null;
  }

  async sourceExists(id: string): Promise<boolean> {
    return this.sources.has(id);
  }

  async create(data: VillageCreateData): Promise<Village> {
    if (this.createError) throw this.createError;

    const now = new Date('2026-03-01T00:00:00Z');
    const row: Village = {
      id: `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`,
      slug: data.slug,
      pcbsCode: null,
      nameAr: data.nameAr,
      nameEn: null,
      governorateId: data.governorateId,
      localAuthorityId: null,
      nameOrigin: null,
      nameOriginSourceId: null,
      latitude: null,
      longitude: null,
      elevationM: null,
      areaDunums: null,
      locationDescription: null,
      historicalOverview: null,
      geoDisplayName: null,
      geoEnrichedAt: null,
      verificationStatus: VerificationStatus.PENDING,
      version: 1,
      createdById: data.createdById,
      updatedById: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const { createdById: _createdById, ...writeData } = data;
    applyWriteData(row, writeData);
    this.rows.set(row.id, row);
    return { ...row };
  }

  async updateIfVersion(id: string, expectedVersion: number, changes: VillageChanges, updatedById: string | null): Promise<number> {
    this.beforeUpdate?.();
    const row = this.rows.get(id);
    if (!row || row.deletedAt || row.version !== expectedVersion) return 0;

    applyWriteData(row, changes);
    row.updatedById = updatedById;
    row.version += 1;
    return 1;
  }

  async softDelete(id: string, updatedById: string): Promise<number> {
    const row = this.rows.get(id);
    if (!row || row.deletedAt) return 0;

    row.deletedAt = new Date();
    row.updatedById = updatedById;
    return 1;
  }
}

class FakeAudit implements VillageAuditRecorder {
  entries: VillageAuditEntry[] = [];
  transactions: Prisma.TransactionClient[] = [];

  async record(tx: Prisma.TransactionClient, entry: VillageAuditEntry): Promise<void> {
    this.transactions.push(tx);
    this.entries.push(entry);
  }
}

let Service: typeof VillageService;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('JWT_ACCESS_SECRET', 'test-secret-with-at-least-32-characters');
  Service = (await import('../src/modules/villages/villages.service.js')).VillageService;
});

describe('VillageService writes', () => {
  let store: FakeVillageStore;
  let audit: FakeAudit;
  let service: VillageService;

  async function createVillage(overrides: Partial<Parameters<VillageService['create']>[0]> = {}): Promise<string> {
    const created = await service.create(
      { slug: 'test-village', nameAr: 'قرية اختبار', governorateId: governorateA, ...overrides },
      editor,
    );
    return created.id;
  }

  beforeEach(() => {
    store = new FakeVillageStore();
    audit = new FakeAudit();
    service = new Service(store, audit);
  });

  it('creates a PENDING village at version 1 and audits CREATE in the same transaction', async () => {
    const created = await service.create(
      { slug: 'test-village', nameAr: 'قرية اختبار', governorateId: governorateA, localAuthorityId: authorityInA, latitude: 32.1, longitude: 35.2 },
      editor,
    );

    expect(created).toMatchObject({
      slug: 'test-village',
      verificationStatus: VerificationStatus.PENDING,
      version: 1,
      latitude: 32.1,
      longitude: 35.2,
    });
    expect(store.rows.get(created.id)?.createdById).toBe('editor-1');
    expect(audit.entries).toEqual([
      expect.objectContaining({
        entityType: 'village',
        entityId: created.id,
        action: AuditAction.CREATE,
        actorId: 'editor-1',
        requestId: 'req-1',
        before: null,
        after: expect.objectContaining({ id: created.id, version: 1 }),
      }),
    ]);
    expect(audit.transactions).toEqual([fakeTx]);
  });

  it('rejects an unknown governorate with 422 and writes nothing', async () => {
    await expect(createVillage({ governorateId: missingGovernorate })).rejects.toMatchObject({
      statusCode: 422,
      code: 'GOVERNORATE_NOT_FOUND',
    });
    expect(store.rows.size).toBe(0);
    expect(audit.entries).toEqual([]);
  });

  it('rejects a local authority from another governorate with 422', async () => {
    await expect(createVillage({ localAuthorityId: authorityInB })).rejects.toMatchObject({
      statusCode: 422,
      code: 'LOCAL_AUTHORITY_GOVERNORATE_MISMATCH',
    });
  });

  it('rejects moving a village to another governorate while it keeps the old local authority', async () => {
    const id = await createVillage({ localAuthorityId: authorityInA });

    await expect(service.update(id, { version: 1, governorateId: governorateB }, editor)).rejects.toMatchObject({
      statusCode: 422,
      code: 'LOCAL_AUTHORITY_GOVERNORATE_MISMATCH',
    });
    await expect(
      service.update(id, { version: 1, governorateId: governorateB, localAuthorityId: authorityInB }, editor),
    ).resolves.toMatchObject({ governorate: { id: governorateB }, version: 2 });
  });

  it('requires a source for nameOrigin, on create and on update', async () => {
    await expect(createVillage({ nameOrigin: 'أصل الاسم' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'NAME_ORIGIN_REQUIRES_SOURCE',
    });

    const id = await createVillage();
    await expect(service.update(id, { version: 1, nameOrigin: 'أصل الاسم' }, editor)).rejects.toMatchObject({
      code: 'NAME_ORIGIN_REQUIRES_SOURCE',
    });
    await expect(
      service.update(id, { version: 1, nameOrigin: 'أصل الاسم', nameOriginSourceId: sourceId }, editor),
    ).resolves.toMatchObject({ nameOrigin: 'أصل الاسم', version: 2 });
  });

  it('updates with the right version, bumps it, resets status to PENDING and audits UPDATE', async () => {
    const id = await createVillage();
    const stored = store.rows.get(id);
    if (!stored) throw new Error('Missing fake village');
    stored.verificationStatus = VerificationStatus.VERIFIED;

    // A reviewer: an editor cannot edit a VERIFIED village directly (see "who may edit a village directly").
    const updated = await service.update(id, { version: 1, nameEn: 'Test Village' }, reviewer);

    expect(updated).toMatchObject({ nameEn: 'Test Village', version: 2, verificationStatus: VerificationStatus.PENDING });
    expect(store.rows.get(id)?.updatedById).toBe('reviewer-1');
    expect(audit.entries[1]).toMatchObject({
      action: AuditAction.UPDATE,
      before: expect.objectContaining({ version: 1, nameEn: null }),
      after: expect.objectContaining({ version: 2, nameEn: 'Test Village' }),
    });
  });

  it('returns 409 VERSION_CONFLICT with the current version for a stale version', async () => {
    const id = await createVillage();
    await service.update(id, { version: 1, nameEn: 'First' }, editor);

    await expect(service.update(id, { version: 1, nameEn: 'Second' }, editor)).rejects.toMatchObject({
      statusCode: 409,
      code: 'VERSION_CONFLICT',
      details: [{ field: 'version', message: 'Current version is 2' }],
    });
    expect(store.rows.get(id)?.nameEn).toBe('First');
    expect(audit.entries.map((entry) => entry.action)).toEqual([AuditAction.CREATE, AuditAction.UPDATE]);
  });

  it('returns 409 when another request wins the race after the version check', async () => {
    const id = await createVillage();
    store.beforeUpdate = () => {
      const row = store.rows.get(id);
      if (row) row.version = 2;
    };

    await expect(service.update(id, { version: 1, nameEn: 'Late' }, editor)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      details: [{ field: 'version', message: 'Current version is 2' }],
    });
  });

  it('returns 404 when updating a missing or soft-deleted village', async () => {
    await expect(service.update(missingVillageId, { version: 1, nameEn: 'x' }, editor)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const id = await createVillage();
    await service.remove(id, reviewer);
    await expect(service.update(id, { version: 1, nameEn: 'x' }, editor)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.verify(id, { version: 1 }, reviewer)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('soft-deletes, audits DELETE, and 404s on a second delete', async () => {
    const id = await createVillage();

    await service.remove(id, reviewer);

    expect(store.rows.get(id)?.deletedAt).toBeInstanceOf(Date);
    expect(audit.entries[1]).toMatchObject({
      action: AuditAction.DELETE,
      actorId: 'reviewer-1',
      before: expect.objectContaining({ deletedAt: null }),
      after: expect.objectContaining({ deletedAt: expect.any(Date) }),
    });
    await expect(service.remove(id, reviewer)).rejects.toBeInstanceOf(NotFoundError);
    expect(audit.entries).toHaveLength(2);
  });

  it('verifies and rejects with version locking, auditing VERIFY and REJECT', async () => {
    const id = await createVillage();

    await expect(service.verify(id, { version: 1 }, reviewer)).resolves.toMatchObject({
      verificationStatus: VerificationStatus.VERIFIED,
      version: 2,
    });
    await expect(service.reject(id, { version: 1 }, reviewer)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(service.reject(id, { version: 2 }, reviewer)).resolves.toMatchObject({
      verificationStatus: VerificationStatus.REJECTED,
      version: 3,
    });
    expect(audit.entries.map((entry) => entry.action)).toEqual([
      AuditAction.CREATE,
      AuditAction.VERIFY,
      AuditAction.REJECT,
    ]);
    expect(audit.transactions.every((tx) => tx === fakeTx)).toBe(true);
  });

  describe('applyGeoEnrichment', () => {
    const point = { latitude: 32.2211, longitude: 35.2544, geoDisplayName: 'Test Village, Nablus, Palestine' };
    const reviewerActor = { id: 'reviewer-1', role: Role.REVIEWER };
    const adminActor = { id: 'admin-1', role: Role.ADMIN };
    const editorActor = { id: 'editor-1', role: Role.EDITOR };

    it('fills an empty village as a system job: version + 1, PENDING, updatedById null, geoEnrichedAt set', async () => {
      const id = await createVillage();

      const result = await service.applyGeoEnrichment(id, point, { actor: null, requestId: 'batch-1' });

      expect(result).toMatchObject({
        status: 'applied',
        village: {
          id,
          version: 2,
          latitude: 32.2211,
          longitude: 35.2544,
          geoDisplayName: 'Test Village, Nablus, Palestine',
          geoEnrichedAt: expect.any(Date),
          verificationStatus: VerificationStatus.PENDING,
        },
      });
      expect(store.rows.get(id)?.updatedById).toBeNull();
      expect(store.rows.get(id)?.geoEnrichedAt).toBeInstanceOf(Date);
    });

    it('audits UPDATE in the same transaction with after.source = geo-enrichment, a null actor and the request id', async () => {
      const id = await createVillage();

      await service.applyGeoEnrichment(id, point, { actor: null, requestId: 'batch-1' });

      expect(audit.entries).toHaveLength(2);
      expect(audit.entries[1]).toMatchObject({
        entityType: 'village',
        entityId: id,
        action: AuditAction.UPDATE,
        actorId: null,
        requestId: 'batch-1',
        before: expect.objectContaining({ latitude: null, version: 1 }),
        after: expect.objectContaining({ version: 2, geoDisplayName: point.geoDisplayName, source: 'geo-enrichment' }),
      });
      expect((audit.entries[1]?.before as Record<string, unknown>).source).toBeUndefined();
      expect(audit.transactions[1]).toBe(fakeTx);
    });

    it('uses the actor id as updatedById and audit actor when an authenticated user calls it', async () => {
      const id = await createVillage();

      await service.applyGeoEnrichment(id, point, { actor: editorActor });

      expect(store.rows.get(id)?.updatedById).toBe('editor-1');
      expect(audit.entries[1]?.actorId).toBe('editor-1');
    });

    it('defaults geoDisplayName to null', async () => {
      const id = await createVillage();

      const result = await service.applyGeoEnrichment(id, { latitude: 32.1, longitude: 35.2 }, { actor: null });

      expect(result.village.geoDisplayName).toBeNull();
    });

    it('skips a village that already has coordinates: nothing changes, no version bump, no audit', async () => {
      const id = await createVillage({ latitude: 32.0, longitude: 35.0 });

      const result = await service.applyGeoEnrichment(id, point, { actor: null });

      expect(result).toEqual({
        status: 'skipped',
        reason: 'COORDINATES_ALREADY_SET',
        village: expect.objectContaining({ version: 1, latitude: 32, longitude: 35, geoDisplayName: null, geoEnrichedAt: null }),
      });
      expect(store.rows.get(id)?.geoDisplayName).toBeNull();
      expect(audit.entries.map((entry) => entry.action)).toEqual([AuditAction.CREATE]);
    });

    it('also skips when only one half of the point is set', async () => {
      const id = await createVillage();
      const row = store.rows.get(id);
      if (row) row.latitude = new Prisma.Decimal(32);

      const result = await service.applyGeoEnrichment(id, point, { actor: null });

      expect(result).toMatchObject({ status: 'skipped', reason: 'COORDINATES_ALREADY_SET' });
      expect(store.rows.get(id)?.longitude).toBeNull();
      expect(audit.entries).toHaveLength(1);
    });

    it('returns 403 for overwrite by an EDITOR or by a system job, before touching the village', async () => {
      const id = await createVillage({ latitude: 32.0, longitude: 35.0 });

      await expect(
        service.applyGeoEnrichment(id, point, { actor: editorActor, overwrite: true, expectedVersion: 1 }),
      ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
      await expect(
        service.applyGeoEnrichment(id, point, { actor: null, overwrite: true, expectedVersion: 1 }),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(store.rows.get(id)?.version).toBe(1);
      expect(audit.entries).toHaveLength(1);
    });

    it('returns 400 for overwrite without expectedVersion', async () => {
      const id = await createVillage({ latitude: 32.0, longitude: 35.0 });

      await expect(service.applyGeoEnrichment(id, point, { actor: reviewerActor, overwrite: true })).rejects.toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        details: [{ field: 'expectedVersion', message: 'expectedVersion is required when overwrite is true' }],
      });
      expect(store.rows.get(id)?.latitude?.toNumber()).toBe(32);
    });

    it('overwrites as a REVIEWER with the right expectedVersion, and sends a VERIFIED village back to PENDING', async () => {
      const id = await createVillage({ latitude: 32.0, longitude: 35.0 });
      await service.verify(id, { version: 1 }, reviewer);

      const result = await service.applyGeoEnrichment(id, point, { actor: reviewerActor, overwrite: true, expectedVersion: 2 });

      expect(result).toMatchObject({
        status: 'applied',
        village: { version: 3, latitude: 32.2211, verificationStatus: VerificationStatus.PENDING },
      });
      expect(store.rows.get(id)?.updatedById).toBe('reviewer-1');
      expect(audit.entries.map((entry) => [entry.action, entry.actorId])).toEqual([
        [AuditAction.CREATE, 'editor-1'],
        [AuditAction.VERIFY, 'reviewer-1'],
        [AuditAction.UPDATE, 'reviewer-1'],
      ]);
      expect(audit.entries[2]?.after).toMatchObject({ source: 'geo-enrichment' });
    });

    it('lets an ADMIN overwrite too', async () => {
      const id = await createVillage({ latitude: 32.0, longitude: 35.0 });

      await expect(
        service.applyGeoEnrichment(id, point, { actor: adminActor, overwrite: true, expectedVersion: 1 }),
      ).resolves.toMatchObject({ status: 'applied', village: { version: 2, latitude: 32.2211 } });
    });

    it('returns 409 for a stale expectedVersion, and when a concurrent edit wins without one', async () => {
      const id = await createVillage();
      await service.update(id, { version: 1, nameEn: 'Edited' }, editor);

      await expect(service.applyGeoEnrichment(id, point, { actor: null, expectedVersion: 1 })).rejects.toMatchObject({
        statusCode: 409,
        code: 'VERSION_CONFLICT',
        details: [{ field: 'version', message: 'Current version is 2' }],
      });

      store.beforeUpdate = () => {
        const row = store.rows.get(id);
        if (row) row.version = 3;
      };
      await expect(service.applyGeoEnrichment(id, point, { actor: null })).rejects.toMatchObject({
        code: 'VERSION_CONFLICT',
        details: [{ field: 'version', message: 'Current version is 3' }],
      });
      expect(store.rows.get(id)?.latitude).toBeNull();
      expect(audit.entries.map((entry) => entry.action)).toEqual([AuditAction.CREATE, AuditAction.UPDATE]);
    });

    it('returns 404 for a soft-deleted, missing or non-UUID village', async () => {
      const id = await createVillage();
      await service.remove(id, reviewer);

      await expect(service.applyGeoEnrichment(id, point, { actor: null })).rejects.toBeInstanceOf(NotFoundError);
      await expect(service.applyGeoEnrichment(missingVillageId, point, { actor: null })).rejects.toBeInstanceOf(NotFoundError);
      await expect(service.applyGeoEnrichment('test-village', point, { actor: null })).rejects.toBeInstanceOf(NotFoundError);
    });

    it('rejects invalid input with 400 before reading the village', async () => {
      const id = await createVillage();

      for (const input of [
        { latitude: 91, longitude: 35 },
        { latitude: 32, longitude: -181 },
        { latitude: 32 } as unknown as typeof point,
        { latitude: Number.NaN, longitude: 35 },
        { ...point, geoDisplayName: 'x'.repeat(501) },
        { ...point, verificationStatus: 'VERIFIED' } as unknown as typeof point,
      ]) {
        await expect(service.applyGeoEnrichment(id, input, { actor: null })).rejects.toMatchObject({ statusCode: 400 });
      }
      await expect(service.applyGeoEnrichment(id, point, { actor: null, expectedVersion: 0 })).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(store.rows.get(id)?.version).toBe(1);
      expect(audit.entries).toHaveLength(1);
    });
  });

  describe('who may edit a village directly', () => {
    // Created by `editor` (editor-1) unless a test says otherwise, with the given status.
    let counter = 0;
    async function villageWith(status: VerificationStatus, creator: WriteActor = editor): Promise<string> {
      counter += 1;
      const created = await service.create(
        { slug: `permission-village-${counter}`, nameAr: 'قرية اختبار', governorateId: governorateA },
        creator,
      );
      const row = store.rows.get(created.id);
      if (!row) throw new Error('Missing fake village');
      row.verificationStatus = status;
      return created.id;
    }

    const rename = { version: 1, nameEn: 'Renamed' };

    describe('an EDITOR', () => {
      it('edits their own PENDING village', async () => {
        const id = await villageWith(VerificationStatus.PENDING);

        const updated = await service.update(id, rename, editor);

        expect(updated).toMatchObject({ nameEn: 'Renamed', version: 2, verificationStatus: VerificationStatus.PENDING });
        expect(audit.entries.map((entry) => entry.action)).toEqual([AuditAction.CREATE, AuditAction.UPDATE]);
      });

      it("cannot edit another editor's PENDING village: 403 VILLAGE_EDIT_FORBIDDEN", async () => {
        const id = await villageWith(VerificationStatus.PENDING, otherEditor);

        await expect(service.update(id, rename, editor)).rejects.toMatchObject({
          statusCode: 403,
          code: 'VILLAGE_EDIT_FORBIDDEN',
        });
      });

      it('cannot edit a village without a creator (for example seeded data)', async () => {
        const id = await villageWith(VerificationStatus.PENDING);
        const row = store.rows.get(id);
        if (row) row.createdById = null;

        await expect(service.update(id, rename, editor)).rejects.toMatchObject({ statusCode: 403, code: 'VILLAGE_EDIT_FORBIDDEN' });
      });

      it('cannot edit a VERIFIED village, even their own: 403 CHANGE_REQUEST_REQUIRED', async () => {
        const id = await villageWith(VerificationStatus.VERIFIED);

        await expect(service.update(id, rename, editor)).rejects.toMatchObject({
          statusCode: 403,
          code: 'CHANGE_REQUEST_REQUIRED',
          message: expect.stringContaining('change request'),
          details: [{ field: 'verificationStatus', message: 'The village is VERIFIED' }],
        });
      });

      it('cannot edit a REJECTED village, even their own: 403 CHANGE_REQUEST_REQUIRED', async () => {
        const id = await villageWith(VerificationStatus.REJECTED);

        await expect(service.update(id, rename, editor)).rejects.toMatchObject({
          statusCode: 403,
          code: 'CHANGE_REQUEST_REQUIRED',
          message: expect.stringContaining('change request'),
        });
      });

      it("gets CHANGE_REQUEST_REQUIRED, not VILLAGE_EDIT_FORBIDDEN, for someone else's VERIFIED village", async () => {
        const id = await villageWith(VerificationStatus.VERIFIED, otherEditor);

        await expect(service.update(id, rename, editor)).rejects.toMatchObject({ statusCode: 403, code: 'CHANGE_REQUEST_REQUIRED' });
      });
    });

    describe('a REVIEWER or an ADMIN', () => {
      it('REVIEWER edits a VERIFIED village; it goes back to PENDING', async () => {
        const id = await villageWith(VerificationStatus.VERIFIED);

        const updated = await service.update(id, rename, reviewer);

        expect(updated).toMatchObject({ version: 2, verificationStatus: VerificationStatus.PENDING });
        expect(store.rows.get(id)?.updatedById).toBe('reviewer-1');
      });

      it("REVIEWER edits a REJECTED village and another editor's PENDING village", async () => {
        const rejected = await villageWith(VerificationStatus.REJECTED);
        await expect(service.update(rejected, rename, reviewer)).resolves.toMatchObject({ version: 2 });

        const pending = await villageWith(VerificationStatus.PENDING, otherEditor);
        await expect(service.update(pending, rename, reviewer)).resolves.toMatchObject({ version: 2 });
      });

      it("ADMIN edits another editor's village, whatever its status", async () => {
        for (const status of [VerificationStatus.PENDING, VerificationStatus.VERIFIED, VerificationStatus.REJECTED]) {
          const id = await villageWith(status, otherEditor);

          await expect(service.update(id, rename, admin)).resolves.toMatchObject({ version: 2, verificationStatus: VerificationStatus.PENDING });
          expect(store.rows.get(id)?.updatedById).toBe('admin-1');
        }
      });
    });

    describe('a refused edit', () => {
      it('writes no audit row, no change and no new version', async () => {
        const id = await villageWith(VerificationStatus.VERIFIED);
        const before = { ...store.rows.get(id) };
        const entriesBefore = audit.entries.length;

        await expect(service.update(id, { ...rename, slug: 'new-slug' }, editor)).rejects.toMatchObject({ statusCode: 403 });

        expect(audit.entries).toHaveLength(entriesBefore);
        expect(store.rows.get(id)).toEqual(before);
        expect(store.rows.get(id)?.version).toBe(1);
        expect(store.rows.get(id)?.verificationStatus).toBe(VerificationStatus.VERIFIED);
      });

      it("a refused edit of another editor's PENDING village also changes nothing", async () => {
        const id = await villageWith(VerificationStatus.PENDING, otherEditor);
        const before = { ...store.rows.get(id) };
        const entriesBefore = audit.entries.length;

        await expect(service.update(id, rename, editor)).rejects.toMatchObject({ statusCode: 403 });

        expect(audit.entries).toHaveLength(entriesBefore);
        expect(store.rows.get(id)).toEqual(before);
      });

      it('is checked in the order 404, then 403, then 409', async () => {
        // 404 first: a missing or deleted village is 404 for an editor, not 403.
        await expect(service.update(missingVillageId, rename, editor)).rejects.toMatchObject({ statusCode: 404 });
        const deleted = await villageWith(VerificationStatus.PENDING);
        await service.remove(deleted, admin);
        await expect(service.update(deleted, rename, editor)).rejects.toMatchObject({ statusCode: 404 });

        // 403 before 409: a stale version from someone who may not edit is still 403.
        const verified = await villageWith(VerificationStatus.VERIFIED);
        const row = store.rows.get(verified);
        if (row) row.version = 5;
        await expect(service.update(verified, { version: 1, nameEn: 'Stale' }, editor)).rejects.toMatchObject({
          statusCode: 403,
          code: 'CHANGE_REQUEST_REQUIRED',
        });

        // 409 for someone who may edit.
        await expect(service.update(verified, { version: 1, nameEn: 'Stale' }, reviewer)).rejects.toMatchObject({
          statusCode: 409,
          code: 'VERSION_CONFLICT',
        });
      });
    });

    it('does not apply to verify and reject, which are limited by role on the route', async () => {
      const id = await villageWith(VerificationStatus.PENDING, otherEditor);

      await expect(service.verify(id, { version: 1 }, reviewer)).resolves.toMatchObject({ verificationStatus: VerificationStatus.VERIFIED });
      await expect(service.reject(id, { version: 2 }, admin)).resolves.toMatchObject({ verificationStatus: VerificationStatus.REJECTED });
    });
  });

  it('maps a duplicate slug from the database to 409 SLUG_TAKEN', async () => {
    store.createError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['slug'] },
    });

    await expect(createVillage()).rejects.toMatchObject({ statusCode: 409, code: 'SLUG_TAKEN' });
  });
});
