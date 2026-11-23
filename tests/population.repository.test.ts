import { beforeEach, describe, expect, it, vi } from 'vitest';
import { populationRepository } from '../src/modules/population/population.repository.js';

const db = vi.hoisted(() => {
  const tx = { populationRecord: { count: vi.fn(), findMany: vi.fn() } };
  return { tx, populationRecord: { findFirst: vi.fn() }, transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)) };
});
vi.mock('../src/shared/db.js', () => ({ prisma: { populationRecord: db.populationRecord, $transaction: db.transaction } }));

beforeEach(() => {
  vi.clearAllMocks();
  db.tx.populationRecord.count.mockResolvedValue(1);
  db.tx.populationRecord.findMany.mockResolvedValue([{ id: 'record', sourceId: 'deleted-source' }]);
  db.populationRecord.findFirst.mockResolvedValue(null);
});

describe('population repository', () => {
  it('applies every filter to count and rows without filtering deleted sources', async () => {
    const filters = { isEstimate: false, isPreferred: false, needsReview: false, referenceYear: 2021, sourceId: 'deleted-source', verificationStatus: 'REJECTED' as const };
    const result = await populationRepository.findMany({ villageId: 'v', filters, sort: { field: 'referenceYear', order: 'desc' }, skip: 0, take: 20 });
    expect(result).toEqual({ items: [{ id: 'record', sourceId: 'deleted-source' }], total: 1 });
    const where = { deletedAt: null, village: { deletedAt: null }, villageId: 'v', ...filters };
    expect(db.tx.populationRecord.count).toHaveBeenCalledWith({ where });
    expect(db.tx.populationRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({ where, skip: 0, take: 20 }));
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'RepeatableRead' });
  });

  it.each([{ field: 'population', order: 'asc' }, { field: 'createdAt', order: 'desc' }] as const)(
    'uses $field $order and ID ascending as a tie-breaker', async sort => {
      await populationRepository.findMany({ villageId: 'v', filters: {}, sort, skip: 100, take: 100 });
      expect(db.tx.populationRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 100, take: 100, orderBy: [{ [sort.field]: sort.order }, { id: 'asc' }] }));
    },
  );

  it('selects no internal user or verification fields for list or detail', async () => {
    await populationRepository.findMany({ villageId: 'v', filters: {}, sort: { field: 'referenceYear', order: 'desc' }, skip: 0, take: 20 });
    await populationRepository.findById('record');
    for (const select of [db.tx.populationRecord.findMany.mock.calls[0][0].select, db.populationRecord.findFirst.mock.calls[0][0].select]) {
      for (const field of ['verifiedById', 'createdById', 'updatedById', 'verifiedAt']) expect(select).not.toHaveProperty(field);
    }
    expect(db.populationRecord.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { deletedAt: null, village: { deletedAt: null }, id: 'record' } }));
  });
});
