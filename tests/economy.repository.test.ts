import { beforeEach, describe, expect, it, vi } from 'vitest';
import { economyRepository, type EconomyDetails, type EconomyListParams } from '../src/modules/economy/economy.repository.js';

const db = vi.hoisted(() => ({
  tx: {
    village: { findFirst: vi.fn() },
    economicActivity: { count: vi.fn(), findMany: vi.fn() },
  },
  economicActivity: { findFirst: vi.fn() },
}));

vi.mock('../src/shared/db.js', () => ({
  prisma: {
    economicActivity: db.economicActivity,
    $transaction: (callback: (tx: typeof db.tx) => Promise<unknown>) => callback(db.tx),
  },
}));

const villageId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const publicSelect = {
  id: true, villageId: true, category: true, name: true, description: true, sourceId: true,
  isMajor: true, asOfYear: true,
  verificationStatus: true, version: true, createdAt: true, updatedAt: true,
};
const params = (): EconomyListParams => ({
  villageId, filters: {}, sort: { field: 'name', order: 'asc' }, skip: 0, take: 20,
});

beforeEach(() => {
  vi.resetAllMocks();
  db.tx.village.findFirst.mockResolvedValue({ id: villageId });
  db.tx.economicActivity.count.mockResolvedValue(0);
  db.tx.economicActivity.findMany.mockResolvedValue([]);
  db.economicActivity.findFirst.mockResolvedValue(null);
});

describe('economyRepository query construction', () => {
  it('checks the active parent before count or retrieval, regardless of filters', async () => {
    db.tx.village.findFirst.mockResolvedValue(null);
    await expect(economyRepository.findMany({ ...params(), filters: { search: 'no matches' } })).resolves.toBeNull();
    expect(db.tx.village.findFirst).toHaveBeenCalledWith({
      where: { id: villageId, deletedAt: null }, select: { id: true },
    });
    expect(db.tx.economicActivity.count).not.toHaveBeenCalled();
    expect(db.tx.economicActivity.findMany).not.toHaveBeenCalled();
  });

  it('uses identical active-item, active-parent and optional predicates for count and retrieval', async () => {
    await economyRepository.findMany({
      ...params(), filters: { search: 'سلال', category: 'CRAFT', verificationStatus: 'REJECTED', isMajor: false, asOfYear: 2014 }, skip: 5, take: 5,
    });
    const where = {
      villageId, deletedAt: null, village: { deletedAt: null },
      category: 'CRAFT', verificationStatus: 'REJECTED',
      isMajor: false, asOfYear: 2014,
      OR: [
        { name: { contains: 'سلال', mode: 'insensitive' } },
        { description: { contains: 'سلال', mode: 'insensitive' } },
      ],
    };
    expect(db.tx.economicActivity.count).toHaveBeenCalledWith({ where });
    expect(db.tx.economicActivity.findMany).toHaveBeenCalledWith({
      where, skip: 5, take: 5, select: publicSelect, orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  });

  it.each([
    { search: 'economy', expected: 'economy' },
    { search: '100%', expected: '100\\%' },
    { search: 'oral_history', expected: 'oral\\_history' },
    { search: 'archive\\record', expected: 'archive\\\\record' },
    { search: 'archive\\', expected: 'archive\\\\' },
    { search: '%_\\', expected: '\\%\\_\\\\' },
  ])('escapes literal search text in both fields: $search', async ({ search, expected }) => {
    await economyRepository.findMany({ ...params(), filters: { search } });
    const where = expect.objectContaining({
      OR: [
        { name: { contains: expected, mode: 'insensitive' } },
        { description: { contains: expected, mode: 'insensitive' } },
      ],
    });
    expect(db.tx.economicActivity.count).toHaveBeenCalledWith({ where });
    expect(db.tx.economicActivity.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
  });

  it.each([
    { field: 'name', order: 'asc', expected: [{ name: 'asc' }, { id: 'asc' }] },
    { field: 'name', order: 'desc', expected: [{ name: 'desc' }, { id: 'asc' }] },
    { field: 'createdAt', order: 'asc', expected: [{ createdAt: 'asc' }, { id: 'asc' }] },
    { field: 'createdAt', order: 'desc', expected: [{ createdAt: 'desc' }, { id: 'asc' }] },
    { field: 'updatedAt', order: 'asc', expected: [{ updatedAt: 'asc' }, { id: 'asc' }] },
    { field: 'updatedAt', order: 'desc', expected: [{ updatedAt: 'desc' }, { id: 'asc' }] },
    { field: 'asOfYear', order: 'asc', expected: [{ asOfYear: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }] },
    { field: 'asOfYear', order: 'desc', expected: [{ asOfYear: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }] },
  ] as const)('appends id ascending to $field $order', async ({ field, order, expected }) => {
    await economyRepository.findMany({ ...params(), sort: { field, order } });
    expect(db.tx.economicActivity.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: expected }));
  });

  it('returns an empty result for an active parent without status or source visibility restrictions', async () => {
    await expect(economyRepository.findMany(params())).resolves.toEqual({ items: [], total: 0 });
    expect(db.tx.economicActivity.count).toHaveBeenCalledWith({
      where: { villageId, deletedAt: null, village: { deletedAt: null }, category: undefined, verificationStatus: undefined,
        isMajor: undefined, asOfYear: undefined },
    });
  });

  it.each([null, villageId])('selects only public fields and returns nullable data with sourceId %j', async (sourceId) => {
    const item: EconomyDetails = {
      id, villageId, category: 'CRAFT', name: 'صناعة السلال', description: null, sourceId,
      isMajor: false, asOfYear: null,
      verificationStatus: 'PENDING', version: 1,
      createdAt: new Date('2026-10-10T00:00:00Z'), updatedAt: new Date('2026-10-10T00:00:00Z'),
    };
    db.tx.economicActivity.count.mockResolvedValue(1);
    db.tx.economicActivity.findMany.mockResolvedValue([item]);
    db.economicActivity.findFirst.mockResolvedValue(item);
    await expect(economyRepository.findMany(params())).resolves.toEqual({ items: [item], total: 1 });
    await expect(economyRepository.findById(id)).resolves.toEqual(item);
    expect(db.tx.economicActivity.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: publicSelect }));
    expect(db.economicActivity.findFirst).toHaveBeenCalledWith({
      where: { id, deletedAt: null, village: { deletedAt: null } }, select: publicSelect,
    });
  });

  it('returns null when no active item with an active parent matches', async () => {
    await expect(economyRepository.findById(id)).resolves.toBeNull();
    expect(db.economicActivity.findFirst).toHaveBeenCalledWith({
      where: { id, deletedAt: null, village: { deletedAt: null } }, select: publicSelect,
    });
  });

  it('propagates database failures', async () => {
    const error = new Error('Database unavailable');
    db.tx.economicActivity.findMany.mockRejectedValue(error);
    db.economicActivity.findFirst.mockRejectedValue(error);
    await expect(economyRepository.findMany(params())).rejects.toBe(error);
    await expect(economyRepository.findById(id)).rejects.toBe(error);
  });

  it.each([{ isMajor: false }, { isMajor: true }, { asOfYear: 0 }, { asOfYear: 2014 }])(
    'preserves an independent filter %j in both queries', async (filters) => {
      await economyRepository.findMany({ ...params(), filters });
      const where = expect.objectContaining(filters);
      expect(db.tx.economicActivity.count).toHaveBeenCalledWith({ where });
      expect(db.tx.economicActivity.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    },
  );

  it.each(['parent', 'count'])('propagates %s lookup failures', async operation => {
    const failure = new Error('Database unavailable');
    (operation === 'parent' ? db.tx.village.findFirst : db.tx.economicActivity.count).mockRejectedValue(failure);
    await expect(economyRepository.findMany(params())).rejects.toBe(failure);
    if (operation === 'parent') expect(db.tx.economicActivity.findMany).not.toHaveBeenCalled();
  });
});
