import { HeritageCategory, VerificationStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeritageDetails, HeritageRepository } from '../src/modules/heritage/heritage.repository.js';
import { HeritageService } from '../src/modules/heritage/heritage.service.js';

vi.mock('../src/shared/db.js', () => ({ prisma: {} }));

const villageId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const item: HeritageDetails = {
  id, villageId, category: HeritageCategory.CRAFT, name: 'صناعة السلال', description: null,
  sourceId: null, verificationStatus: VerificationStatus.PENDING, version: 1,
  createdAt: new Date('2026-10-10T00:00:00Z'), updatedAt: new Date('2026-10-10T00:00:00Z'),
};

describe('HeritageService', () => {
  const repo = {
    findMany: vi.fn<HeritageRepository['findMany']>(),
    findById: vi.fn<HeritageRepository['findById']>(),
  };
  const service = new HeritageService(repo);

  beforeEach(() => {
    vi.resetAllMocks();
    repo.findMany.mockResolvedValue({ items: [], total: 0 });
    repo.findById.mockResolvedValue(null);
  });

  it('defaults to name ascending, page 1 and limit 20 without a status restriction', async () => {
    const result = await service.list(villageId, {});
    expect(repo.findMany).toHaveBeenCalledWith({
      villageId, filters: { search: undefined, category: undefined, verificationStatus: undefined },
      sort: { field: 'name', order: 'asc' }, skip: 0, take: 20,
    });
    expect(result).toEqual({
      items: [],
      meta: { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false },
    });
  });

  it('forwards filters and sorting and builds page metadata', async () => {
    repo.findMany.mockResolvedValue({ items: [item], total: 12 });
    const result = await service.list(villageId, {
      page: 2, limit: 5, search: 'سلال', category: HeritageCategory.CRAFT,
      verificationStatus: VerificationStatus.REJECTED, sort: 'updatedAt', order: 'desc',
    });
    expect(repo.findMany).toHaveBeenCalledWith({
      villageId,
      filters: { search: 'سلال', category: HeritageCategory.CRAFT, verificationStatus: VerificationStatus.REJECTED },
      sort: { field: 'updatedAt', order: 'desc' }, skip: 5, take: 5,
    });
    expect(result).toEqual({
      items: [item],
      meta: { page: 2, limit: 5, total: 12, totalPages: 3, hasNextPage: true, hasPrevPage: true },
    });
  });

  it('caps the page size at 100', async () => {
    expect((await service.list(villageId, { limit: 500 })).meta.limit).toBe(100);
    expect(repo.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });

  it('keeps an empty page beyond the final page distinct from a missing village', async () => {
    repo.findMany.mockResolvedValue({ items: [], total: 1 });
    expect(await service.list(villageId, { page: 3, limit: 5 })).toEqual({
      items: [],
      meta: { page: 3, limit: 5, total: 1, totalPages: 1, hasNextPage: false, hasPrevPage: true },
    });
  });

  it('maps a missing/deleted parent result to the standard village 404', async () => {
    repo.findMany.mockResolvedValue(null);
    await expect(service.list(villageId, {})).rejects.toMatchObject({
      statusCode: 404, code: 'NOT_FOUND', message: 'Village not found',
    });
  });

  it.each(Object.values(VerificationStatus))('returns repository data with status %s and nullable fields', async (status) => {
    const result = { ...item, verificationStatus: status };
    repo.findById.mockResolvedValue(result);
    await expect(service.getById(id)).resolves.toEqual(result);
    expect(repo.findById).toHaveBeenCalledWith(id);
  });

  it('maps an invisible/missing item result to the standard item 404', async () => {
    await expect(service.getById(id)).rejects.toMatchObject({
      statusCode: 404, code: 'NOT_FOUND', message: 'Heritage item not found',
    });
  });

  it('propagates unexpected repository failures', async () => {
    const error = new Error('Database unavailable');
    repo.findMany.mockRejectedValue(error);
    repo.findById.mockRejectedValue(error);
    await expect(service.list(villageId, {})).rejects.toBe(error);
    await expect(service.getById(id)).rejects.toBe(error);
  });
});
