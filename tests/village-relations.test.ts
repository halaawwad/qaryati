import {
  AuditAction,
  PlaceRelation,
  PlaceType,
  Prisma,
  VerificationStatus,
  VillageNameType,
  type NearbyPlace,
  type Village,
  type VillageName,
} from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry, AuditRecorder } from '../src/modules/audit/audit.service.js';
import type { VillageRelationsService } from '../src/modules/villages/village-relations.service.js';
import type {
  NearbyPlaceCreateData,
  VillageNameChanges,
  VillageNameCreateData,
  VillageRepository,
  VillageWriteRepository,
} from '../src/modules/villages/villages.repository.js';
import type { WriteActor } from '../src/modules/villages/villages.service.js';
import { NotFoundError, ValidationError } from '../src/shared/errors.js';

const villageA = '11111111-1111-4111-8111-111111111111';
const villageB = '22222222-2222-4222-8222-222222222222';
const deletedVillage = '33333333-3333-4333-8333-333333333333';
const villageC = '44444444-4444-4444-8444-444444444444';
const missingId = '99999999-9999-4999-8999-999999999999';
const sourceId = '66666666-6666-4666-8666-666666666666';

const editor: WriteActor = { userId: 'editor-1', requestId: 'req-1' };
const reviewer: WriteActor = { userId: 'reviewer-1', requestId: 'req-2' };
const fakeTx = { fake: 'tx' } as unknown as Prisma.TransactionClient;

function village(id: string, nameAr: string, deletedAt: Date | null = null): Village {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    id,
    slug: `test-${id.slice(0, 4)}`,
    pcbsCode: null,
    nameAr,
    nameEn: null,
    governorateId: 'gov-1',
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
    createdById: null,
    updatedById: null,
    deletedAt,
    createdAt: now,
    updatedAt: now,
  };
}

function notUsed(): never {
  throw new Error('not used');
}

class FakeRelationsStore implements VillageRepository, VillageWriteRepository {
  villages = new Map<string, Village>([
    [villageA, village(villageA, 'قرية أ')],
    [villageB, village(villageB, 'قرية ب')],
    [villageC, village(villageC, 'قرية ج')],
    [deletedVillage, village(deletedVillage, 'قرية محذوفة', new Date('2026-02-01T00:00:00Z'))],
  ]);
  sources = new Set([sourceId]);
  names = new Map<string, VillageName>();
  nearby = new Map<string, NearbyPlace>();
  transactions = 0;
  /** Runs right before updateNameIfVersion, to simulate a concurrent request. */
  beforeNameUpdate: (() => void) | undefined;
  createNearbyError: unknown;
  private nextId = 1;

  private newId(): string {
    return `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`;
  }

  async transaction<T>(fn: (writes: VillageWriteRepository, tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    this.transactions += 1;
    return fn(this, fakeTx);
  }

  findMany = notUsed;
  findDetails = notUsed;
  exists = notUsed;
  findLocation = notUsed;
  findNearbyPlaceRows = notUsed;
  findVillagesWithinRadius = notUsed;
  governorateExists = notUsed;
  findLocalAuthorityGovernorateId = notUsed;
  create = notUsed;
  updateIfVersion = notUsed;
  softDelete = notUsed;

  async findById(id: string): Promise<Village | null> {
    const row = this.villages.get(id);
    return row ? { ...row } : null;
  }

  async sourceExists(id: string): Promise<boolean> {
    return this.sources.has(id);
  }

  async findNameById(id: string): Promise<VillageName | null> {
    const row = this.names.get(id);
    return row ? { ...row } : null;
  }

  async nameTaken(villageId: string, name: string, language: string, exceptId?: string): Promise<boolean> {
    return [...this.names.values()].some(
      (row) =>
        row.villageId === villageId &&
        row.language === language &&
        !row.deletedAt &&
        row.id !== exceptId &&
        row.name.toLowerCase() === name.toLowerCase(),
    );
  }

  async createName(data: VillageNameCreateData): Promise<VillageName> {
    const now = new Date('2026-03-01T00:00:00Z');
    const row: VillageName = {
      id: this.newId(),
      villageId: data.villageId,
      name: data.name,
      language: data.language,
      nameType: data.nameType,
      periodFrom: data.periodFrom ?? null,
      periodTo: data.periodTo ?? null,
      sourceId: data.sourceId ?? null,
      verificationStatus: VerificationStatus.PENDING,
      version: 1,
      createdById: data.createdById,
      updatedById: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.names.set(row.id, row);
    return { ...row };
  }

  async updateNameIfVersion(id: string, expectedVersion: number, changes: VillageNameChanges, updatedById: string): Promise<number> {
    this.beforeNameUpdate?.();
    const row = this.names.get(id);
    if (!row || row.deletedAt || row.version !== expectedVersion) return 0;

    for (const [key, value] of Object.entries(changes)) {
      if (value !== undefined) Object.assign(row, { [key]: value });
    }
    row.updatedById = updatedById;
    row.version += 1;
    return 1;
  }

  async softDeleteName(id: string, updatedById: string): Promise<number> {
    const row = this.names.get(id);
    if (!row || row.deletedAt) return 0;

    row.deletedAt = new Date();
    row.updatedById = updatedById;
    return 1;
  }

  async findNearbyById(id: string): Promise<NearbyPlace | null> {
    const row = this.nearby.get(id);
    return row ? { ...row } : null;
  }

  async findRelationBetween(a: string, b: string): Promise<NearbyPlace | null> {
    return (
      [...this.nearby.values()].find(
        (row) => (row.villageId === a && row.relatedVillageId === b) || (row.villageId === b && row.relatedVillageId === a),
      ) ?? null
    );
  }

  async placeNameTaken(villageId: string, placeName: string): Promise<boolean> {
    return [...this.nearby.values()].some((row) => row.villageId === villageId && row.placeName === placeName);
  }

  async createNearby(data: NearbyPlaceCreateData): Promise<NearbyPlace> {
    if (this.createNearbyError) throw this.createNearbyError;

    const now = new Date('2026-03-01T00:00:00Z');
    const row: NearbyPlace = {
      ...data,
      id: this.newId(),
      distanceKm: data.distanceKm === null ? null : new Prisma.Decimal(data.distanceKm),
      createdAt: now,
      updatedAt: now,
    };
    this.nearby.set(row.id, row);
    return { ...row };
  }

  async deleteNearby(id: string): Promise<number> {
    return this.nearby.delete(id) ? 1 : 0;
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

let Service: typeof VillageRelationsService;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('JWT_ACCESS_SECRET', 'test-secret-with-at-least-32-characters');
  Service = (await import('../src/modules/villages/village-relations.service.js')).VillageRelationsService;
});

let store: FakeRelationsStore;
let audit: FakeAudit;
let service: VillageRelationsService;

beforeEach(() => {
  store = new FakeRelationsStore();
  audit = new FakeAudit();
  service = new Service(store, audit);
});

describe('VillageRelationsService names', () => {
  const bayta = { name: 'Bayta', language: 'en' as const, nameType: VillageNameType.TRANSLITERATION };

  it('adds a PENDING name at version 1 and audits CREATE village_name in the same transaction', async () => {
    const created = await service.addName(villageA, { ...bayta, sourceId }, editor);

    expect(created).toMatchObject({ villageId: villageA, name: 'Bayta', verificationStatus: 'PENDING', version: 1, sourceId });
    expect(created).not.toHaveProperty('createdById');
    expect(created).not.toHaveProperty('deletedAt');
    expect(store.names.get(created.id)?.createdById).toBe('editor-1');
    expect(audit.entries).toEqual([
      expect.objectContaining({
        entityType: 'village_name',
        entityId: created.id,
        action: AuditAction.CREATE,
        actorId: 'editor-1',
        requestId: 'req-1',
        before: null,
      }),
    ]);
    expect(audit.transactions).toEqual([fakeTx]);
  });

  it('returns 404 for a missing or soft-deleted village and writes nothing', async () => {
    await expect(service.addName(missingId, bayta, editor)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.addName(deletedVillage, bayta, editor)).rejects.toBeInstanceOf(NotFoundError);
    expect(store.names.size).toBe(0);
    expect(audit.entries).toEqual([]);
  });

  it('rejects an unknown source with 422', async () => {
    await expect(service.addName(villageA, { ...bayta, sourceId: missingId }, editor)).rejects.toMatchObject({
      statusCode: 422,
      code: 'SOURCE_NOT_FOUND',
    });
    expect(audit.entries).toEqual([]);
  });

  it('rejects the same name in the same language (case-insensitive), but not in another language or once deleted', async () => {
    const first = await service.addName(villageA, bayta, editor);

    await expect(service.addName(villageA, { ...bayta, name: 'BAYTA' }, editor)).rejects.toMatchObject({
      statusCode: 409,
      code: 'VILLAGE_NAME_EXISTS',
    });
    await expect(service.addName(villageA, { ...bayta, language: 'ar' }, editor)).resolves.toMatchObject({ language: 'ar' });
    await expect(service.addName(villageB, bayta, editor)).resolves.toMatchObject({ villageId: villageB });

    await service.removeName(villageA, first.id, reviewer);
    await expect(service.addName(villageA, bayta, editor)).resolves.toMatchObject({ name: 'Bayta' });
  });

  it('updates with the right version, bumps it, resets to PENDING and audits UPDATE', async () => {
    const created = await service.addName(villageA, bayta, editor);
    const stored = store.names.get(created.id);
    if (!stored) throw new Error('Missing fake name');
    stored.verificationStatus = VerificationStatus.VERIFIED;

    const updated = await service.updateName(villageA, created.id, { version: 1, periodFrom: 1900 }, editor);

    expect(updated).toMatchObject({ periodFrom: 1900, version: 2, verificationStatus: 'PENDING' });
    expect(audit.entries[1]).toMatchObject({
      entityType: 'village_name',
      action: AuditAction.UPDATE,
      before: expect.objectContaining({ version: 1, periodFrom: null }),
      after: expect.objectContaining({ version: 2, periodFrom: 1900 }),
    });
  });

  it('allows renaming a name to a different case of itself', async () => {
    const created = await service.addName(villageA, bayta, editor);

    await expect(service.updateName(villageA, created.id, { version: 1, name: 'BAYTA' }, editor)).resolves.toMatchObject({
      name: 'BAYTA',
    });
  });

  it('returns 409 VERSION_CONFLICT for a stale version and when losing a race', async () => {
    const created = await service.addName(villageA, bayta, editor);
    await service.updateName(villageA, created.id, { version: 1, periodFrom: 1900 }, editor);

    await expect(service.updateName(villageA, created.id, { version: 1, periodFrom: 1800 }, editor)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      details: [{ field: 'version', message: 'Current version is 2' }],
    });

    store.beforeNameUpdate = () => {
      const row = store.names.get(created.id);
      if (row) row.version = 3;
    };
    await expect(service.updateName(villageA, created.id, { version: 2, periodFrom: 1700 }, editor)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      details: [{ field: 'version', message: 'Current version is 3' }],
    });
    expect(audit.entries).toHaveLength(2);
  });

  it('checks the period against the stored other end on update (400)', async () => {
    const created = await service.addName(villageA, { ...bayta, periodFrom: 1900 }, editor);

    await expect(service.updateName(villageA, created.id, { version: 1, periodTo: 1850 }, editor)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(audit.entries).toHaveLength(1);
  });

  it("returns 404 for another village's name, a missing name, and a deleted name", async () => {
    const created = await service.addName(villageA, bayta, editor);

    await expect(service.updateName(villageB, created.id, { version: 1, periodFrom: 1 }, editor)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Village name not found',
    });
    await expect(service.removeName(villageB, created.id, reviewer)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.removeName(villageA, missingId, reviewer)).rejects.toBeInstanceOf(NotFoundError);

    await service.removeName(villageA, created.id, reviewer);
    await expect(service.removeName(villageA, created.id, reviewer)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.updateName(villageA, created.id, { version: 1, periodFrom: 1 }, editor)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('soft-deletes and audits DELETE with before and after', async () => {
    const created = await service.addName(villageA, bayta, editor);

    await service.removeName(villageA, created.id, reviewer);

    expect(store.names.get(created.id)?.deletedAt).toBeInstanceOf(Date);
    expect(audit.entries[1]).toMatchObject({
      entityType: 'village_name',
      action: AuditAction.DELETE,
      actorId: 'reviewer-1',
      before: expect.objectContaining({ deletedAt: null }),
      after: expect.objectContaining({ deletedAt: expect.any(Date) }),
    });
  });
});

describe('VillageRelationsService nearby places', () => {
  it('relates two villages, naming the place after the related village', async () => {
    const created = await service.addNearby(villageA, { relatedVillageId: villageB, relation: PlaceRelation.ADJACENT, distanceKm: 3 }, editor);

    expect(created).toMatchObject({
      villageId: villageA,
      relatedVillageId: villageB,
      placeName: 'قرية ب',
      placeType: PlaceType.VILLAGE,
      relation: PlaceRelation.ADJACENT,
      distanceKm: 3,
    });
    expect(audit.entries).toEqual([
      expect.objectContaining({ entityType: 'nearby_place', action: AuditAction.CREATE, entityId: created.id, before: null }),
    ]);
    expect(audit.transactions).toEqual([fakeTx]);
  });

  it('stores a place that is not one of our villages', async () => {
    await expect(
      service.addNearby(villageA, { placeName: 'نابلس', placeType: PlaceType.CITY, relation: PlaceRelation.NEARBY }, editor),
    ).resolves.toMatchObject({ relatedVillageId: null, placeName: 'نابلس', placeType: PlaceType.CITY, distanceKm: null });
  });

  it('rejects a village related to itself with 422 before opening a transaction', async () => {
    await expect(
      service.addNearby(villageA, { relatedVillageId: villageA, relation: PlaceRelation.NEARBY }, editor),
    ).rejects.toMatchObject({ statusCode: 422, code: 'NEARBY_SELF_RELATION' });
    expect(store.transactions).toBe(0);
    expect(audit.entries).toEqual([]);
  });

  it('returns 404 for a missing village and 422 for a missing or deleted related village', async () => {
    const input = { relatedVillageId: villageB, relation: PlaceRelation.NEARBY };

    await expect(service.addNearby(missingId, input, editor)).rejects.toBeInstanceOf(NotFoundError);
    for (const relatedVillageId of [missingId, deletedVillage]) {
      await expect(service.addNearby(villageA, { ...input, relatedVillageId }, editor)).rejects.toMatchObject({
        statusCode: 422,
        code: 'RELATED_VILLAGE_NOT_FOUND',
      });
    }
    expect(audit.entries).toEqual([]);
  });

  it('returns 409 NEARBY_RELATION_EXISTS when the pair is already stored in either direction', async () => {
    await service.addNearby(villageA, { relatedVillageId: villageB, relation: PlaceRelation.NEARBY }, editor);

    await expect(
      service.addNearby(villageB, { relatedVillageId: villageA, relation: PlaceRelation.NEARBY }, editor),
    ).rejects.toMatchObject({ statusCode: 409, code: 'NEARBY_RELATION_EXISTS' });
    await expect(
      service.addNearby(villageA, { relatedVillageId: villageB, relation: PlaceRelation.ADJACENT }, editor),
    ).rejects.toMatchObject({ code: 'NEARBY_RELATION_EXISTS' });
    expect(audit.entries).toHaveLength(1);
  });

  it('returns 409 NEARBY_PLACE_NAME_EXISTS for the same place name on the same village', async () => {
    await service.addNearby(villageA, { placeName: 'نابلس', placeType: PlaceType.CITY, relation: PlaceRelation.NEARBY }, editor);

    await expect(
      service.addNearby(villageA, { placeName: 'نابلس', placeType: PlaceType.CITY, relation: PlaceRelation.ADJACENT }, editor),
    ).rejects.toMatchObject({ statusCode: 409, code: 'NEARBY_PLACE_NAME_EXISTS' });
  });

  it('maps the database errors seen on the real server when a race gets past the checks', async () => {
    const input = { relatedVillageId: villageB, relation: PlaceRelation.NEARBY };

    store.createNearbyError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { modelName: 'NearbyPlace', target: ['LEAST(village_id', 'related_village_id)', 'GREATEST(village_id', 'related_village_id)'] },
    });
    await expect(service.addNearby(villageA, input, editor)).rejects.toMatchObject({ code: 'NEARBY_RELATION_EXISTS' });

    store.createNearbyError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { modelName: 'NearbyPlace', target: ['village_id', 'place_name'] },
    });
    await expect(service.addNearby(villageA, input, editor)).rejects.toMatchObject({ code: 'NEARBY_PLACE_NAME_EXISTS' });

    store.createNearbyError = new Prisma.PrismaClientUnknownRequestError(
      'new row for relation "nearby_places" violates check constraint "nearby_places_not_self_check"',
      { clientVersion: 'test' },
    );
    await expect(service.addNearby(villageA, input, editor)).rejects.toMatchObject({ code: 'NEARBY_SELF_RELATION' });
    expect(audit.entries).toEqual([]);
  });

  it('hard-deletes from either side and audits DELETE with the full row as before', async () => {
    const created = await service.addNearby(villageA, { relatedVillageId: villageB, relation: PlaceRelation.ADJACENT, distanceKm: 3 }, editor);

    await service.removeNearby(villageB, created.id, reviewer);

    expect(store.nearby.has(created.id)).toBe(false);
    expect(audit.entries[1]).toMatchObject({
      entityType: 'nearby_place',
      action: AuditAction.DELETE,
      actorId: 'reviewer-1',
      entityId: created.id,
      before: expect.objectContaining({ id: created.id, villageId: villageA, relatedVillageId: villageB, placeName: 'قرية ب' }),
      after: null,
    });
  });

  it('returns 404 for a relation that does not involve the village, or does not exist', async () => {
    const created = await service.addNearby(villageA, { relatedVillageId: villageB, relation: PlaceRelation.NEARBY }, editor);

    await expect(service.removeNearby(villageC, created.id, reviewer)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Nearby relation not found',
    });
    await expect(service.removeNearby(villageA, missingId, reviewer)).rejects.toBeInstanceOf(NotFoundError);
    expect(store.nearby.has(created.id)).toBe(true);
    expect(audit.entries).toHaveLength(1);
  });
});
