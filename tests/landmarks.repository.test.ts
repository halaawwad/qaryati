import { LandmarkType, Prisma, VerificationStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { landmarkRepository, type LandmarkListParams } from '../src/modules/landmarks/landmarks.repository.js';

const db = vi.hoisted(() => ({
  village: { findFirst: vi.fn() },
  landmark: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
}));

vi.mock('../src/shared/db.js', () => ({
  prisma: {
    ...db,
    $transaction: (callback: (tx: typeof db) => Promise<unknown>) => callback(db),
  },
}));

const villageId = '11111111-1111-4111-8111-111111111111';
const landmarkId = '22222222-2222-4222-8222-222222222222';

function params(): LandmarkListParams {
  return { villageId, filters: {}, sort: { field: 'nameAr', order: 'asc' }, skip: 0, take: 20 };
}

function row() {
  return {
    id: landmarkId,
    villageId,
    nameAr: 'عين البلد',
    nameEn: 'Village Spring',
    landmarkType: LandmarkType.SPRING,
    description: null,
    latitude: new Prisma.Decimal('32.123456'),
    longitude: new Prisma.Decimal('35.654321'),
    sourceId: null,
    verificationStatus: VerificationStatus.PENDING,
    version: 1,
    createdAt: new Date('2026-10-10T00:00:00Z'),
    updatedAt: new Date('2026-10-10T00:00:00Z'),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  db.village.findFirst.mockResolvedValue({ id: villageId });
  db.landmark.count.mockResolvedValue(0);
  db.landmark.findMany.mockResolvedValue([]);
  db.landmark.findFirst.mockResolvedValue(null);
});

describe('landmarkRepository', () => {
  it('checks for an active village and does not query landmarks if it is missing or deleted', async () => {
    db.village.findFirst.mockResolvedValue(null);
    await expect(landmarkRepository.findMany(params())).resolves.toBeNull();
    expect(db.village.findFirst).toHaveBeenCalledWith({
      where: { id: villageId, deletedAt: null }, select: { id: true },
    });
    expect(db.landmark.findMany).not.toHaveBeenCalled();
    expect(db.landmark.count).not.toHaveBeenCalled();
  });

  it('applies identical active-record, village, search, and enum filters to rows and count', async () => {
    const input = params();
    input.filters = {
      search: 'Spring', landmarkType: LandmarkType.SPRING, verificationStatus: VerificationStatus.REJECTED,
    };
    input.skip = 5;
    input.take = 5;
    await landmarkRepository.findMany(input);

    const where = {
      villageId,
      deletedAt: null,
      village: { deletedAt: null },
      landmarkType: LandmarkType.SPRING,
      verificationStatus: VerificationStatus.REJECTED,
      OR: [
        { nameAr: { contains: 'Spring', mode: 'insensitive' } },
        { nameEn: { contains: 'Spring', mode: 'insensitive' } },
      ],
    };
    expect(db.landmark.count).toHaveBeenCalledWith({ where });
    expect(db.landmark.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where, skip: 5, take: 5, orderBy: [{ nameAr: 'asc' }, { id: 'asc' }],
    }));
  });

  it('leaves verification status unrestricted and puts null English names last with a stable tie-breaker', async () => {
    const input = params();
    input.sort = { field: 'nameEn', order: 'desc' };
    await landmarkRepository.findMany(input);
    expect(db.landmark.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ verificationStatus: undefined }),
      orderBy: [{ nameEn: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
    }));
  });

  it('returns an empty list for an existing village with no matching landmarks', async () => {
    await expect(landmarkRepository.findMany(params())).resolves.toEqual({ items: [], total: 0 });
  });

  it('converts Decimal coordinates to numbers in list and detail responses', async () => {
    db.landmark.count.mockResolvedValue(1);
    db.landmark.findMany.mockResolvedValue([row()]);
    db.landmark.findFirst.mockResolvedValue(row());

    const list = await landmarkRepository.findMany(params());
    const detail = await landmarkRepository.findById(landmarkId);
    expect(list?.items[0]).toMatchObject({ latitude: 32.123456, longitude: 35.654321 });
    expect(detail).toEqual(list?.items[0]);
    expect(list?.total).toBe(1);
  });

  it('preserves null and zero coordinates', async () => {
    db.landmark.findFirst.mockResolvedValue({ ...row(), latitude: null, longitude: new Prisma.Decimal(0) });
    await expect(landmarkRepository.findById(landmarkId)).resolves.toMatchObject({ latitude: null, longitude: 0 });
  });

  it('restricts detail lookup to an active landmark and active village and returns null for no match', async () => {
    await expect(landmarkRepository.findById(landmarkId)).resolves.toBeNull();
    expect(db.landmark.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: landmarkId, deletedAt: null, village: { deletedAt: null } },
    }));
  });
});
