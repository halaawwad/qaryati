import { LocalAuthorityType } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GovernorateDetails,
  GovernorateRepository,
  GovernorateSummary,
  LocalAuthorityFilter,
  LocalAuthoritySummary,
} from '../src/modules/governorates/governorates.repository.js';
import type { GovernorateService } from '../src/modules/governorates/governorates.service.js';
import { NotFoundError } from '../src/shared/errors.js';

const governorateId = '11111111-1111-4111-8111-111111111111';
const missingId = '99999999-9999-4999-8999-999999999999';

class FakeGovernorateRepository implements GovernorateRepository {
  governorates: GovernorateDetails[] = [];
  localAuthorities: LocalAuthoritySummary[] = [];
  lastLocalAuthorityFilter: LocalAuthorityFilter | undefined;

  async findAll(): Promise<GovernorateSummary[]> {
    return this.governorates.map(({ localAuthoritiesCount: _count, ...governorate }) => governorate);
  }

  async findById(id: string): Promise<GovernorateDetails | null> {
    return this.governorates.find((governorate) => governorate.id === id) ?? null;
  }

  async findLocalAuthorities(id: string, filter: LocalAuthorityFilter): Promise<LocalAuthoritySummary[] | null> {
    this.lastLocalAuthorityFilter = filter;
    if (!this.governorates.some((governorate) => governorate.id === id)) return null;

    return this.localAuthorities.filter(
      (authority) => authority.governorateId === id && (!filter.type || authority.type === filter.type),
    );
  }
}

let Service: typeof GovernorateService;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('JWT_ACCESS_SECRET', 'test-secret-with-at-least-32-characters');
  Service = (await import('../src/modules/governorates/governorates.service.js')).GovernorateService;
});

describe('GovernorateService', () => {
  let repo: FakeGovernorateRepository;

  beforeEach(() => {
    repo = new FakeGovernorateRepository();
    repo.governorates.push({
      id: governorateId,
      nameAr: 'محافظة اختبار',
      nameEn: 'Test Governorate',
      code: 'TST',
      villagesCount: 3,
      localAuthoritiesCount: 2,
    });
    repo.localAuthorities.push(
      {
        id: 'authority-1',
        governorateId,
        nameAr: 'بلدية اختبار',
        nameEn: 'Test Municipality',
        type: LocalAuthorityType.MUNICIPALITY,
        sourceId: null,
        asOfYear: null,
      },
      {
        id: 'authority-2',
        governorateId,
        nameAr: 'مجلس قروي اختبار',
        nameEn: null,
        type: LocalAuthorityType.VILLAGE_COUNCIL,
        sourceId: null,
        asOfYear: null,
      },
    );
  });

  it('lists governorates with their village counts', async () => {
    await expect(new Service(repo).list()).resolves.toEqual([
      { id: governorateId, nameAr: 'محافظة اختبار', nameEn: 'Test Governorate', code: 'TST', villagesCount: 3 },
    ]);
  });

  it('returns a governorate by id', async () => {
    await expect(new Service(repo).getById(governorateId)).resolves.toMatchObject({
      id: governorateId,
      villagesCount: 3,
      localAuthoritiesCount: 2,
    });
  });

  it('throws NotFoundError for an unknown governorate id', async () => {
    await expect(new Service(repo).getById(missingId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('passes the type filter to the repository', async () => {
    const result = await new Service(repo).listLocalAuthorities(governorateId, {
      type: LocalAuthorityType.MUNICIPALITY,
    });

    expect(repo.lastLocalAuthorityFilter).toEqual({ type: LocalAuthorityType.MUNICIPALITY });
    expect(result.map((authority) => authority.id)).toEqual(['authority-1']);
  });

  it('throws NotFoundError for local authorities of an unknown governorate', async () => {
    await expect(new Service(repo).listLocalAuthorities(missingId, {})).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });
});
