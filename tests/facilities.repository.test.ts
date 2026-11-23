import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { facilitiesRepository, type FacilitiesDetails, type FacilitiesListParams } from '../src/modules/facilities/facilities.repository.js';

const db = vi.hoisted(() => ({
  tx: {
    facility: { count: vi.fn(), findMany: vi.fn() },
  },
  facility: { findFirst: vi.fn() },
}));

vi.mock('../src/shared/db.js', () => ({
  prisma: {
    facility: db.facility,
    $transaction: (callback: (tx: typeof db.tx) => Promise<unknown>) => callback(db.tx),
  },
}));

const villageId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const publicSelect = {
  id: true, villageId: true, facilityType: true, name: true, description: true, sourceId: true,
  latitude: true, longitude: true, asOfYear: true,
  verificationStatus: true, version: true, createdAt: true, updatedAt: true,
};
const params = (): FacilitiesListParams => ({
  villageId, filters: {}, sort: { field: 'name', order: 'asc' }, skip: 0, take: 20,
});

beforeEach(() => {
  vi.resetAllMocks();
  db.tx.facility.count.mockResolvedValue(0);
  db.tx.facility.findMany.mockResolvedValue([]);
  db.facility.findFirst.mockResolvedValue(null);
});

describe('facilitiesRepository query construction', () => {
  it('uses identical active-item, active-parent and optional predicates for count and retrieval', async () => {
    await facilitiesRepository.findMany({
      ...params(), filters: { search: 'مدرسة', facilityType: 'SCHOOL', verificationStatus: 'REJECTED', asOfYear: 0 }, skip: 5, take: 5,
    });
    const where = {
      villageId, deletedAt: null, village: { deletedAt: null },
      facilityType: 'SCHOOL', verificationStatus: 'REJECTED', asOfYear: 0,
      OR: [
        { name: { contains: 'مدرسة', mode: 'insensitive' } },
        { description: { contains: 'مدرسة', mode: 'insensitive' } },
      ],
    };
    expect(db.tx.facility.count).toHaveBeenCalledWith({ where });
    expect(db.tx.facility.findMany).toHaveBeenCalledWith({
      where, skip: 5, take: 5, select: publicSelect, orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  });

  it.each([
    { search: 'facilities', expected: 'facilities' },
    { search: '100%', expected: '100\\%' },
    { search: 'oral_history', expected: 'oral\\_history' },
    { search: 'archive\\record', expected: 'archive\\\\record' },
    { search: 'archive\\', expected: 'archive\\\\' },
    { search: '%_\\', expected: '\\%\\_\\\\' },
  ])('escapes literal search text in both fields: $search', async ({ search, expected }) => {
    await facilitiesRepository.findMany({ ...params(), filters: { search } });
    const where = expect.objectContaining({
      OR: [
        { name: { contains: expected, mode: 'insensitive' } },
        { description: { contains: expected, mode: 'insensitive' } },
      ],
    });
    expect(db.tx.facility.count).toHaveBeenCalledWith({ where });
    expect(db.tx.facility.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
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
    await facilitiesRepository.findMany({ ...params(), sort: { field, order } });
    expect(db.tx.facility.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: expected }));
  });

  it('returns an empty result for an active parent without status or source visibility restrictions', async () => {
    await expect(facilitiesRepository.findMany(params())).resolves.toEqual({ items: [], total: 0 });
    expect(db.tx.facility.count).toHaveBeenCalledWith({
      where: { villageId, deletedAt: null, village: { deletedAt: null }, facilityType: undefined, verificationStatus: undefined, asOfYear: undefined },
    });
  });

  it.each([null, villageId])('selects only public fields and returns nullable data with sourceId %j', async (sourceId) => {
    const item: FacilitiesDetails = {
      id, villageId, facilityType: 'SCHOOL', name: 'مدرسة القرية', description: null, sourceId,
      latitude: null, longitude: null, asOfYear: null,
      verificationStatus: 'PENDING', version: 1,
      createdAt: new Date('2026-10-10T00:00:00Z'), updatedAt: new Date('2026-10-10T00:00:00Z'),
    };
    db.tx.facility.count.mockResolvedValue(1);
    db.tx.facility.findMany.mockResolvedValue([item]);
    db.facility.findFirst.mockResolvedValue(item);
    await expect(facilitiesRepository.findMany(params())).resolves.toEqual({ items: [item], total: 1 });
    await expect(facilitiesRepository.findById(id)).resolves.toEqual(item);
    expect(db.tx.facility.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: publicSelect }));
    expect(db.facility.findFirst).toHaveBeenCalledWith({
      where: { id, deletedAt: null, village: { deletedAt: null } }, select: publicSelect,
    });
  });

  it('returns null when no active item with an active parent matches', async () => {
    await expect(facilitiesRepository.findById(id)).resolves.toBeNull();
    expect(db.facility.findFirst).toHaveBeenCalledWith({
      where: { id, deletedAt: null, village: { deletedAt: null } }, select: publicSelect,
    });
  });

  it('propagates database failures', async () => {
    const error = new Error('Database unavailable');
    db.tx.facility.findMany.mockRejectedValue(error);
    db.facility.findFirst.mockRejectedValue(error);
    await expect(facilitiesRepository.findMany(params())).rejects.toBe(error);
    await expect(facilitiesRepository.findById(id)).rejects.toBe(error);
  });

  it.each([
    { latitude: 32.123456, longitude: 35.654321 },
    { latitude: null, longitude: 0 },
    { latitude: 0, longitude: null },
    { latitude: -90, longitude: 180 },
  ])('converts Decimal coordinates in list and detail: %j', async coordinates => {
    const row = {
      id, villageId, facilityType: 'SCHOOL', name: 'مدرسة', description: null, sourceId: null,
      asOfYear: 0, verificationStatus: 'VERIFIED', version: 1,
      createdAt: new Date('2026-10-10T00:00:00Z'), updatedAt: new Date('2026-10-10T00:00:00Z'),
      latitude: coordinates.latitude === null ? null : new Prisma.Decimal(coordinates.latitude),
      longitude: coordinates.longitude === null ? null : new Prisma.Decimal(coordinates.longitude),
    };
    db.tx.facility.count.mockResolvedValue(1);
    db.tx.facility.findMany.mockResolvedValue([row]);
    db.facility.findFirst.mockResolvedValue(row);
    const expected = { ...row, ...coordinates };
    await expect(facilitiesRepository.findMany(params())).resolves.toEqual({ items: [expected], total: 1 });
    await expect(facilitiesRepository.findById(id)).resolves.toEqual(expected);
  });

  it.each([0, -2147483648, 2147483647])('preserves an independent exact year filter %s', async asOfYear => {
    await facilitiesRepository.findMany({ ...params(), filters: { asOfYear } });
    expect(db.tx.facility.count).toHaveBeenCalledWith({ where: expect.objectContaining({ asOfYear }) });
    expect(db.tx.facility.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ asOfYear }),
    }));
  });

  it('propagates count failures', async () => {
    const error = new Error('Count unavailable');
    db.tx.facility.count.mockRejectedValue(error);
    await expect(facilitiesRepository.findMany(params())).rejects.toBe(error);
  });
});
