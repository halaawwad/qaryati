import { VerificationStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eventRepository, type EventDetails, type EventListParams } from '../src/modules/events/events.repository.js';
import { EVENT_SORT_FIELDS } from '../src/modules/events/events.schemas.js';

const db = vi.hoisted(() => ({
  village: { findFirst: vi.fn() },
  historicalEvent: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
}));

vi.mock('../src/shared/db.js', () => ({
  prisma: {
    ...db,
    $transaction: (callback: (tx: typeof db) => Promise<unknown>) => callback(db),
  },
}));

const villageId = '11111111-1111-4111-8111-111111111111';
const eventId = '22222222-2222-4222-8222-222222222222';
const publicSelect = {
  id: true, villageId: true, title: true, description: true, eventYear: true, eventDate: true,
  isApproximate: true, category: true, sourceId: true, verificationStatus: true,
  version: true, createdAt: true, updatedAt: true,
};

function params(): EventListParams {
  return { villageId, filters: {}, sort: { field: 'eventYear', order: 'asc' }, skip: 0, take: 20 };
}

function row(): EventDetails {
  return {
    id: eventId, villageId, title: 'حدث تاريخي', description: null, eventYear: null, eventDate: null,
    isApproximate: false, category: null, sourceId: null, verificationStatus: VerificationStatus.PENDING,
    version: 1, createdAt: new Date('2026-10-10T00:00:00Z'), updatedAt: new Date('2026-10-10T00:00:00Z'),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  db.village.findFirst.mockResolvedValue({ id: villageId });
  db.historicalEvent.count.mockResolvedValue(0);
  db.historicalEvent.findMany.mockResolvedValue([]);
  db.historicalEvent.findFirst.mockResolvedValue(null);
});

describe('eventRepository', () => {
  it('requires an active parent even if the requested filters would yield no events', async () => {
    db.village.findFirst.mockResolvedValue(null);
    await expect(eventRepository.findMany({ ...params(), filters: { search: 'no matches' } })).resolves.toBeNull();
    expect(db.village.findFirst).toHaveBeenCalledWith({
      where: { id: villageId, deletedAt: null }, select: { id: true },
    });
    expect(db.historicalEvent.count).not.toHaveBeenCalled();
    expect(db.historicalEvent.findMany).not.toHaveBeenCalled();
  });

  it('uses matching visibility, text, category, boolean, status and inclusive year predicates for rows and count', async () => {
    const filters = {
      search: 'heritage', category: 'Heritage', verificationStatus: VerificationStatus.REJECTED,
      isApproximate: false, yearFrom: -100, yearTo: 0,
    };
    await eventRepository.findMany({ ...params(), filters, skip: 5, take: 5 });
    const where = {
      villageId, deletedAt: null, village: { deletedAt: null },
      verificationStatus: VerificationStatus.REJECTED, isApproximate: false,
      OR: [
        { title: { contains: 'heritage', mode: 'insensitive' } },
        { description: { contains: 'heritage', mode: 'insensitive' } },
      ],
      category: { equals: 'Heritage', mode: 'insensitive' },
      eventYear: { gte: -100, lte: 0 },
    };
    expect(db.historicalEvent.count).toHaveBeenCalledWith({ where });
    expect(db.historicalEvent.findMany).toHaveBeenCalledWith({
      where, skip: 5, take: 5, select: publicSelect,
      orderBy: [{ eventYear: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    });
  });

  it.each([
    { input: 'Heritage', expected: 'Heritage' },
    { input: '100% heritage', expected: '100\\% heritage' },
    { input: 'oral_history', expected: 'oral\\_history' },
    { input: 'archive\\record', expected: 'archive\\\\record' },
    { input: 'archive\\', expected: 'archive\\\\' },
    { input: '%_\\', expected: '\\%\\_\\\\' },
  ])('passes literal text patterns to Prisma for category and search: $input', async ({ input, expected }) => {
    await eventRepository.findMany({ ...params(), filters: { category: input, search: input } });

    // Fixed expected strings check the real repository's escaping without reimplementing it.
    const where = expect.objectContaining({
      category: { equals: expected, mode: 'insensitive' },
      OR: [
        { title: { contains: expected, mode: 'insensitive' } },
        { description: { contains: expected, mode: 'insensitive' } },
      ],
    });
    expect(db.historicalEvent.count).toHaveBeenCalledWith({ where });
    expect(db.historicalEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
  });

  it.each([
    { filters: { yearFrom: 0 }, expected: { gte: 0, lte: undefined } },
    { filters: { yearTo: 0 }, expected: { gte: undefined, lte: 0 } },
  ])('applies a single year bound including zero: $filters', async ({ filters, expected }) => {
    await eventRepository.findMany({ ...params(), filters });
    expect(db.historicalEvent.count).toHaveBeenCalledWith({ where: expect.objectContaining({ eventYear: expected }) });
  });

  it.each(EVENT_SORT_FIELDS)('uses a stable id tie-breaker for %s in both directions', async (field) => {
    for (const order of ['asc', 'desc'] as const) {
      await eventRepository.findMany({ ...params(), sort: { field, order } });
      const primary = field === 'eventYear' || field === 'eventDate'
        ? { [field]: { sort: order, nulls: 'last' } }
        : { [field]: order };
      expect(db.historicalEvent.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
        orderBy: [primary, { id: 'asc' }],
      }));
    }
  });

  it('returns an empty collection for an active village and does not require a status or active source', async () => {
    await expect(eventRepository.findMany(params())).resolves.toEqual({ items: [], total: 0 });
    expect(db.historicalEvent.count).toHaveBeenCalledWith({
      where: { villageId, deletedAt: null, village: { deletedAt: null }, verificationStatus: undefined, isApproximate: undefined },
    });
  });

  it('selects only public fields and preserves nulls in both list and detail', async () => {
    const event = row();
    db.historicalEvent.count.mockResolvedValue(1);
    db.historicalEvent.findMany.mockResolvedValue([event]);
    db.historicalEvent.findFirst.mockResolvedValue(event);
    await expect(eventRepository.findMany(params())).resolves.toEqual({ items: [event], total: 1 });
    await expect(eventRepository.findById(eventId)).resolves.toEqual(event);
    expect(db.historicalEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: publicSelect }));
    expect(db.historicalEvent.findFirst).toHaveBeenCalledWith({
      where: { id: eventId, deletedAt: null, village: { deletedAt: null } }, select: publicSelect,
    });
  });

  it('preserves a null eventYear even when eventDate is present and exposes only the source ID', async () => {
    const event = { ...row(), eventDate: new Date('2014-06-20T00:00:00Z'), sourceId: villageId };
    db.historicalEvent.findFirst.mockResolvedValue(event);
    await expect(eventRepository.findById(eventId)).resolves.toEqual(event);
    expect(db.historicalEvent.findFirst).toHaveBeenCalledWith({
      where: { id: eventId, deletedAt: null, village: { deletedAt: null } }, select: publicSelect,
    });
  });

  it('returns null when no active event with an active parent matches', async () => {
    await expect(eventRepository.findById(eventId)).resolves.toBeNull();
  });
});
