import { VerificationStatus, VillageNameType } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  VillageDetails,
  VillageListItem,
  VillageListParams,
  VillageLookup,
  VillageRepository,
} from '../src/modules/villages/villages.repository.js';
import type { VillageService } from '../src/modules/villages/villages.service.js';
import { NotFoundError } from '../src/shared/errors.js';

const governorateId = '11111111-1111-4111-8111-111111111111';
const localAuthorityId = '22222222-2222-4222-8222-222222222222';
const villageId = '33333333-3333-4333-8333-333333333333';
const deletedVillageId = '44444444-4444-4444-8444-444444444444';
const missingVillageId = '99999999-9999-4999-8999-999999999999';

type StoredVillage = VillageDetails & { deletedAt: Date | null };

class FakeVillageRepository implements VillageRepository {
  items: VillageListItem[] = [];
  total = 0;
  lastParams: VillageListParams | undefined;
  villages: StoredVillage[] = [];
  lastLookup: VillageLookup | undefined;
  existsCalls = 0;

  async findMany(params: VillageListParams): Promise<{ items: VillageListItem[]; total: number }> {
    this.lastParams = params;
    return { items: this.items, total: this.total };
  }

  async findDetails(lookup: VillageLookup): Promise<VillageDetails | null> {
    this.lastLookup = lookup;
    const found = this.villages.find(
      (stored) => !stored.deletedAt && ('id' in lookup ? stored.id === lookup.id : stored.slug === lookup.slug),
    );
    if (!found) return null;

    const { deletedAt: _deletedAt, ...details } = found;
    return details;
  }

  async exists(id: string): Promise<boolean> {
    this.existsCalls += 1;
    return this.villages.some((stored) => stored.id === id && !stored.deletedAt);
  }
}

function storedVillage(id: string, slug: string, deletedAt: Date | null = null): StoredVillage {
  return {
    id,
    slug,
    pcbsCode: null,
    nameAr: 'قرية اختبار',
    nameEn: 'Test Village',
    nameOrigin: null,
    latitude: null,
    longitude: null,
    elevationM: 500,
    areaDunums: 1200.5,
    locationDescription: null,
    historicalOverview: null,
    geoDisplayName: null,
    geoEnrichedAt: null,
    verificationStatus: VerificationStatus.PENDING,
    version: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    governorate: { id: governorateId, nameAr: 'محافظة اختبار', nameEn: 'Test Governorate', code: 'TST' },
    localAuthority: null,
    nameOriginSource: null,
    names: [
      {
        id: 'name-1',
        name: 'Test Alt',
        language: 'en',
        nameType: VillageNameType.ALT_SPELLING,
        periodFrom: null,
        periodTo: null,
        source: null,
      },
    ],
    deletedAt,
  };
}

function village(id: string): VillageListItem {
  return {
    id,
    slug: `test-village-${id}`,
    nameAr: 'قرية اختبار',
    nameEn: 'Test Village',
    verificationStatus: VerificationStatus.PENDING,
    governorate: { id: governorateId, nameAr: 'محافظة اختبار', nameEn: 'Test Governorate' },
    localAuthority: null,
    latitude: 32.1,
    longitude: 35.2,
  };
}

let Service: typeof VillageService;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('JWT_ACCESS_SECRET', 'test-secret-with-at-least-32-characters');
  Service = (await import('../src/modules/villages/villages.service.js')).VillageService;
});

describe('VillageService list', () => {
  let repo: FakeVillageRepository;

  beforeEach(() => {
    repo = new FakeVillageRepository();
  });

  it('returns the requested page with pagination meta', async () => {
    repo.items = [village('v6'), village('v7')];
    repo.total = 12;

    const result = await new Service(repo).list({ page: 2, limit: 5 });

    expect(repo.lastParams).toMatchObject({ skip: 5, take: 5 });
    expect(result.items).toEqual(repo.items);
    expect(result.meta).toEqual({
      page: 2,
      limit: 5,
      total: 12,
      totalPages: 3,
      hasNextPage: true,
      hasPrevPage: true,
    });
  });

  it('passes filters, search and sort to the repository', async () => {
    await new Service(repo).list({
      search: 'Bayta',
      governorateId,
      localAuthorityId,
      verificationStatus: VerificationStatus.VERIFIED,
      sort: 'elevationM',
      order: 'desc',
    });

    expect(repo.lastParams).toEqual({
      filters: {
        search: 'Bayta',
        governorateId,
        localAuthorityId,
        verificationStatus: VerificationStatus.VERIFIED,
      },
      sort: { field: 'elevationM', order: 'desc' },
      skip: 0,
      take: 20,
    });
  });

  it('defaults to the first page, 20 items and nameAr ascending', async () => {
    const result = await new Service(repo).list({});

    expect(repo.lastParams).toEqual({
      filters: {
        search: undefined,
        governorateId: undefined,
        localAuthorityId: undefined,
        verificationStatus: undefined,
      },
      sort: { field: 'nameAr', order: 'asc' },
      skip: 0,
      take: 20,
    });
    expect(result.meta).toMatchObject({ page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false });
  });

  it('caps limit at 100', async () => {
    const result = await new Service(repo).list({ limit: 500 });

    expect(repo.lastParams).toMatchObject({ take: 100 });
    expect(result.meta.limit).toBe(100);
  });
});

describe('VillageService details', () => {
  let repo: FakeVillageRepository;

  beforeEach(() => {
    repo = new FakeVillageRepository();
    repo.villages.push(
      storedVillage(villageId, 'test-village'),
      storedVillage(deletedVillageId, 'deleted-village', new Date('2026-02-01T00:00:00Z')),
    );
  });

  it('looks a village up by id when the param is a UUID', async () => {
    const village = await new Service(repo).getByIdOrSlug(villageId);

    expect(repo.lastLookup).toEqual({ id: villageId });
    expect(village).toMatchObject({ id: villageId, slug: 'test-village', names: [{ name: 'Test Alt' }] });
    expect(village).not.toHaveProperty('deletedAt');
  });

  it('looks a village up by slug otherwise', async () => {
    const village = await new Service(repo).getByIdOrSlug('test-village');

    expect(repo.lastLookup).toEqual({ slug: 'test-village' });
    expect(village.id).toBe(villageId);
  });

  it('throws NotFoundError for an unknown village', async () => {
    await expect(new Service(repo).getByIdOrSlug(missingVillageId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(new Service(repo).getByIdOrSlug('unknown-slug')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFoundError for a soft-deleted village', async () => {
    await expect(new Service(repo).getByIdOrSlug(deletedVillageId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(new Service(repo).getByIdOrSlug('deleted-village')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('ensureExists resolves for an active village', async () => {
    await expect(new Service(repo).ensureExists(villageId)).resolves.toBeUndefined();
  });

  it('ensureExists throws NotFoundError for missing, deleted or malformed ids', async () => {
    const service = new Service(repo);

    await expect(service.ensureExists(missingVillageId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.ensureExists(deletedVillageId)).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.existsCalls).toBe(2);

    await expect(service.ensureExists('test-village')).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.existsCalls).toBe(2);
  });
});
