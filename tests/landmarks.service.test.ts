import { LandmarkType, VerificationStatus } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LandmarkDetails,
  LandmarkListParams,
  LandmarkRepository,
} from '../src/modules/landmarks/landmarks.repository.js';
import type { LandmarkService } from '../src/modules/landmarks/landmarks.service.js';

const villageId = '11111111-1111-4111-8111-111111111111';
const landmarkId = '22222222-2222-4222-8222-222222222222';

function landmark(status: VerificationStatus = VerificationStatus.PENDING): LandmarkDetails {
  return {
    id: landmarkId,
    villageId,
    nameAr: 'عين البلد',
    nameEn: 'Village Spring',
    landmarkType: LandmarkType.SPRING,
    description: null,
    latitude: 32.1,
    longitude: 35.2,
    sourceId: null,
    verificationStatus: status,
    version: 1,
    createdAt: new Date('2026-10-10T00:00:00Z'),
    updatedAt: new Date('2026-10-10T00:00:00Z'),
  };
}

class FakeLandmarkRepository implements LandmarkRepository {
  listResult: { items: LandmarkDetails[]; total: number } | null = { items: [], total: 0 };
  detail: LandmarkDetails | null = null;
  lastParams: LandmarkListParams | undefined;
  lastId: string | undefined;

  async findMany(params: LandmarkListParams): Promise<{ items: LandmarkDetails[]; total: number } | null> {
    this.lastParams = params;
    return this.listResult;
  }

  async findById(id: string): Promise<LandmarkDetails | null> {
    this.lastId = id;
    return this.detail;
  }
}

let Service: typeof LandmarkService;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('JWT_ACCESS_SECRET', 'test-secret-with-at-least-32-characters');
  Service = (await import('../src/modules/landmarks/landmarks.service.js')).LandmarkService;
});

describe('LandmarkService', () => {
  let repo: FakeLandmarkRepository;

  beforeEach(() => {
    repo = new FakeLandmarkRepository();
  });

  it('defaults to page 1, limit 20, nameAr ascending, and unrestricted verification status', async () => {
    const result = await new Service(repo).list(villageId, {});

    expect(repo.lastParams).toEqual({
      villageId,
      filters: { search: undefined, landmarkType: undefined, verificationStatus: undefined },
      sort: { field: 'nameAr', order: 'asc' },
      skip: 0,
      take: 20,
    });
    expect(result).toEqual({
      items: [],
      meta: { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false },
    });
  });

  it('passes the village, filters, and sort and returns pagination metadata', async () => {
    repo.listResult = { items: [landmark()], total: 12 };
    const result = await new Service(repo).list(villageId, {
      page: 2,
      limit: 5,
      search: 'Spring',
      landmarkType: LandmarkType.SPRING,
      verificationStatus: VerificationStatus.PENDING,
      sort: 'createdAt',
      order: 'desc',
    });

    expect(repo.lastParams).toEqual({
      villageId,
      filters: { search: 'Spring', landmarkType: LandmarkType.SPRING, verificationStatus: VerificationStatus.PENDING },
      sort: { field: 'createdAt', order: 'desc' },
      skip: 5,
      take: 5,
    });
    expect(result.items).toEqual(repo.listResult.items);
    expect(result.meta).toEqual({
      page: 2, limit: 5, total: 12, totalPages: 3, hasNextPage: true, hasPrevPage: true,
    });
  });

  it('caps the limit at 100', async () => {
    const result = await new Service(repo).list(villageId, { limit: 500 });
    expect(repo.lastParams?.take).toBe(100);
    expect(result.meta.limit).toBe(100);
  });

  it('returns an empty page rather than 404 when the page is beyond the last result', async () => {
    repo.listResult = { items: [], total: 1 };
    const result = await new Service(repo).list(villageId, { page: 3, limit: 5 });
    expect(result.items).toEqual([]);
    expect(result.meta).toMatchObject({ total: 1, totalPages: 1, hasNextPage: false, hasPrevPage: true });
  });

  it('returns the standard village 404 when the repository reports a missing or deleted parent', async () => {
    repo.listResult = null;
    await expect(new Service(repo).list(villageId, {})).rejects.toMatchObject({
      statusCode: 404, code: 'NOT_FOUND', message: 'Village not found',
    });
  });

  it.each([VerificationStatus.PENDING, VerificationStatus.VERIFIED, VerificationStatus.REJECTED])(
    'returns an active %s landmark without a verified-only restriction',
    async (status) => {
      repo.detail = landmark(status);
      await expect(new Service(repo).getById(landmarkId)).resolves.toEqual(repo.detail);
      expect(repo.lastId).toBe(landmarkId);
    },
  );

  it('returns the standard landmark 404 when the record or its village is missing or deleted', async () => {
    await expect(new Service(repo).getById(landmarkId)).rejects.toMatchObject({
      statusCode: 404, code: 'NOT_FOUND', message: 'Landmark not found',
    });
  });

  it('propagates unexpected repository failures instead of reporting them as missing resources', async () => {
    const failure = new Error('Database unavailable');
    vi.spyOn(repo, 'findMany').mockRejectedValue(failure);
    vi.spyOn(repo, 'findById').mockRejectedValue(failure);

    await expect(new Service(repo).list(villageId, {})).rejects.toBe(failure);
    await expect(new Service(repo).getById(landmarkId)).rejects.toBe(failure);
  });
});
