import { AuditAction, Prisma, VerificationStatus, type Village } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry, AuditRecorder } from '../src/modules/audit/audit.service.js';
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

const editor: WriteActor = { userId: 'editor-1', requestId: 'req-1' };
const reviewer: WriteActor = { userId: 'reviewer-1', requestId: 'req-2' };
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

  async updateIfVersion(id: string, expectedVersion: number, changes: VillageChanges, updatedById: string): Promise<number> {
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

  // Names and nearby places are covered by tests/village-relations.test.ts.
  async findNameById(): Promise<never> {
    throw new Error('not used');
  }

  async nameTaken(): Promise<never> {
    throw new Error('not used');
  }

  async createName(): Promise<never> {
    throw new Error('not used');
  }

  async updateNameIfVersion(): Promise<never> {
    throw new Error('not used');
  }

  async softDeleteName(): Promise<never> {
    throw new Error('not used');
  }

  async findNearbyById(): Promise<never> {
    throw new Error('not used');
  }

  async findRelationBetween(): Promise<never> {
    throw new Error('not used');
  }

  async placeNameTaken(): Promise<never> {
    throw new Error('not used');
  }

  async createNearby(): Promise<never> {
    throw new Error('not used');
  }

  async deleteNearby(): Promise<never> {
    throw new Error('not used');
  }
}

class FakeAudit implements AuditRecorder {
  entries: AuditEntry[] = [];
  transactions: Prisma.TransactionClient[] = [];

  async record(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
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

    const updated = await service.update(id, { version: 1, nameEn: 'Test Village' }, editor);

    expect(updated).toMatchObject({ nameEn: 'Test Village', version: 2, verificationStatus: VerificationStatus.PENDING });
    expect(store.rows.get(id)?.updatedById).toBe('editor-1');
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

  it('maps a duplicate slug from the database to 409 SLUG_TAKEN', async () => {
    store.createError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['slug'] },
    });

    await expect(createVillage()).rejects.toMatchObject({ statusCode: 409, code: 'SLUG_TAKEN' });
  });
});
