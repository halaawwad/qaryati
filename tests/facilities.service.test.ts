import { VerificationStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FacilitiesDetails, FacilitiesRepository } from '../src/modules/facilities/facilities.repository.js';
import { FacilitiesService } from '../src/modules/facilities/facilities.service.js';
import { NotFoundError } from '../src/shared/errors.js';

vi.mock('../src/shared/db.js', () => ({ prisma: {} }));

const villageId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const item: FacilitiesDetails = {
  id, villageId, facilityType: 'SCHOOL', name: 'مدرسة القرية', description: null,
  latitude: null, longitude: 0, sourceId: null, asOfYear: null,
  verificationStatus: 'PENDING', version: 1,
  createdAt: new Date('2026-10-10T00:00:00Z'), updatedAt: new Date('2026-10-10T00:00:00Z'),
};

describe('FacilitiesService', () => {
  const repo = {
    findForWrite: vi.fn<FacilitiesRepository['findForWrite']>(),
    lock: vi.fn<FacilitiesRepository['lock']>(),
    updateIfVersion: vi.fn<FacilitiesRepository['updateIfVersion']>(),
    softDelete: vi.fn<FacilitiesRepository['softDelete']>(),
    transaction: vi.fn<FacilitiesRepository['transaction']>(),
    create: vi.fn<FacilitiesRepository['create']>(),
    findMany: vi.fn<FacilitiesRepository['findMany']>(),
    findById: vi.fn<FacilitiesRepository['findById']>(),
  };
  const villages = { ensureExists: vi.fn<(id: string) => Promise<void>>() };
  const service = new FacilitiesService(repo, villages);

  beforeEach(() => {
    vi.resetAllMocks();
    villages.ensureExists.mockResolvedValue(undefined);
    repo.findMany.mockResolvedValue({ items: [], total: 0 });
    repo.findById.mockResolvedValue(null);
  });

  it('checks the parent through its service and applies public list defaults', async () => {
    expect(await service.list(villageId, {})).toEqual({
      items: [], meta: { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false },
    });
    expect(villages.ensureExists).toHaveBeenCalledTimes(2);
    expect(villages.ensureExists).toHaveBeenNthCalledWith(1, villageId);
    expect(villages.ensureExists).toHaveBeenNthCalledWith(2, villageId);
    expect(villages.ensureExists.mock.invocationCallOrder[0]).toBeLessThan(repo.findMany.mock.invocationCallOrder[0]!);
    expect(villages.ensureExists.mock.invocationCallOrder[1]).toBeGreaterThan(repo.findMany.mock.invocationCallOrder[0]!);
    expect(repo.findMany).toHaveBeenCalledWith({
      villageId, filters: { search: undefined, facilityType: undefined, verificationStatus: undefined, asOfYear: undefined },
      sort: { field: 'name', order: 'asc' }, skip: 0, take: 20,
    });
  });

  it('forwards all filters including year zero and builds pagination metadata', async () => {
    repo.findMany.mockResolvedValue({ items: [item], total: 12 });
    expect(await service.list(villageId, {
      page: 2, limit: 5, search: 'مدرسة', facilityType: 'SCHOOL', verificationStatus: 'REJECTED',
      asOfYear: 0, sort: 'asOfYear', order: 'desc',
    })).toEqual({
      items: [item], meta: { page: 2, limit: 5, total: 12, totalPages: 3, hasNextPage: true, hasPrevPage: true },
    });
    expect(repo.findMany).toHaveBeenCalledWith({
      villageId, filters: { search: 'مدرسة', facilityType: 'SCHOOL', verificationStatus: 'REJECTED', asOfYear: 0 },
      sort: { field: 'asOfYear', order: 'desc' }, skip: 5, take: 5,
    });
    expect(villages.ensureExists).toHaveBeenCalledExactlyOnceWith(villageId);
  });

  it('caps the page size at 100', async () => {
    expect((await service.list(villageId, { limit: 500 })).meta.limit).toBe(100);
    expect(repo.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });

  it('returns an empty page beyond the results without reporting a missing village', async () => {
    repo.findMany.mockResolvedValue({ items: [], total: 1 });
    expect(await service.list(villageId, { page: 3, limit: 5 })).toEqual({
      items: [], meta: { page: 3, limit: 5, total: 1, totalPages: 1, hasNextPage: false, hasPrevPage: true },
    });
  });

  it('preserves the village 404 and does not query facilities when the parent is invisible', async () => {
    villages.ensureExists.mockRejectedValue(new NotFoundError('Village not found'));
    await expect(service.list(villageId, { search: 'no matches' })).rejects.toMatchObject({
      statusCode: 404, code: 'NOT_FOUND', message: 'Village not found',
    });
    expect(repo.findMany).not.toHaveBeenCalled();
  });

  it.each([0, 1])('returns 404 when the parent is deleted before an empty page is returned (total=%s)', async total => {
    repo.findMany.mockImplementation(async () => {
      // The initial parent check passed; deletion is committed before the rows are read.
      villages.ensureExists.mockRejectedValue(new NotFoundError('Village not found'));
      return { items: [], total };
    });
    await expect(service.list(villageId, {})).rejects.toMatchObject({
      statusCode: 404, code: 'NOT_FOUND', message: 'Village not found',
    });
    expect(repo.findMany).toHaveBeenCalledTimes(1);
    expect(villages.ensureExists).toHaveBeenCalledTimes(2);
  });

  it('propagates a failed parent recheck instead of returning an empty success', async () => {
    const failure = new Error('Parent lookup unavailable');
    villages.ensureExists.mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
    await expect(service.list(villageId, {})).rejects.toBe(failure);
  });

  it.each(Object.values(VerificationStatus))('returns a public %s detail with nullable fields', async status => {
    const result = { ...item, verificationStatus: status };
    repo.findById.mockResolvedValue(result);
    await expect(service.getById(id)).resolves.toEqual(result);
    expect(repo.findById).toHaveBeenCalledExactlyOnceWith(id);
  });

  it('returns a facility 404 for a missing/deleted facility or deleted parent', async () => {
    await expect(service.getById(id)).rejects.toMatchObject({
      statusCode: 404, code: 'NOT_FOUND', message: 'Facility not found',
    });
  });

  it('propagates unexpected repository failures', async () => {
    const failure = new Error('Database unavailable');
    repo.findMany.mockRejectedValue(failure);
    repo.findById.mockRejectedValue(failure);
    await expect(service.list(villageId, {})).rejects.toBe(failure);
    await expect(service.getById(id)).rejects.toBe(failure);
  });

  it('propagates village lookup failures without querying facilities', async () => {
    const failure = new Error('Parent lookup unavailable');
    villages.ensureExists.mockRejectedValue(failure);
    await expect(service.list(villageId, {})).rejects.toBe(failure);
    expect(repo.findMany).not.toHaveBeenCalled();
  });
});
