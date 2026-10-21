import { VerificationStatus } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  VillageListItem,
  VillageListParams,
  VillageRepository,
} from '../src/modules/villages/villages.repository.js';
import type { VillageService } from '../src/modules/villages/villages.service.js';

const governorateId = '11111111-1111-4111-8111-111111111111';
const localAuthorityId = '22222222-2222-4222-8222-222222222222';

class FakeVillageRepository implements VillageRepository {
  items: VillageListItem[] = [];
  total = 0;
  lastParams: VillageListParams | undefined;

  async findMany(params: VillageListParams): Promise<{ items: VillageListItem[]; total: number }> {
    this.lastParams = params;
    return { items: this.items, total: this.total };
  }
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
