import { VerificationStatus } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventDetails, EventListParams, EventRepository } from '../src/modules/events/events.repository.js';
import type { EventService } from '../src/modules/events/events.service.js';

const villageId = '11111111-1111-4111-8111-111111111111';
const eventId = '22222222-2222-4222-8222-222222222222';

function event(verificationStatus: VerificationStatus = VerificationStatus.PENDING): EventDetails {
  return {
    id: eventId, villageId, title: 'حدث تاريخي', description: null,
    eventYear: null, eventDate: new Date('2014-06-20T00:00:00Z'), isApproximate: false,
    category: null, sourceId: null, verificationStatus, version: 1,
    createdAt: new Date('2026-10-10T00:00:00Z'), updatedAt: new Date('2026-10-10T00:00:00Z'),
  };
}

class FakeEventRepository implements EventRepository {
  listResult: { items: EventDetails[]; total: number } | null = { items: [], total: 0 };
  detail: EventDetails | null = null;
  lastParams: EventListParams | undefined;
  lastId: string | undefined;

  async findMany(params: EventListParams): Promise<{ items: EventDetails[]; total: number } | null> {
    this.lastParams = params;
    return this.listResult;
  }

  async findById(id: string): Promise<EventDetails | null> {
    this.lastId = id;
    return this.detail;
  }
}

let Service: typeof EventService;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('JWT_ACCESS_SECRET', 'test-secret-with-at-least-32-characters');
  Service = (await import('../src/modules/events/events.service.js')).EventService;
});

describe('EventService', () => {
  let repo: FakeEventRepository;

  beforeEach(() => { repo = new FakeEventRepository(); });

  it('defaults to page 1, limit 20 and eventYear ascending without restricting status', async () => {
    const result = await new Service(repo).list(villageId, {});
    expect(repo.lastParams).toEqual({
      villageId,
      filters: {
        search: undefined, category: undefined, verificationStatus: undefined,
        isApproximate: undefined, yearFrom: undefined, yearTo: undefined,
      },
      sort: { field: 'eventYear', order: 'asc' }, skip: 0, take: 20,
    });
    expect(result).toEqual({
      items: [], meta: { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false },
    });
  });

  it('passes filters, false, year zero and sorting, and builds the requested page metadata', async () => {
    repo.listResult = { items: [event()], total: 12 };
    const result = await new Service(repo).list(villageId, {
      page: 2, limit: 5, search: 'heritage', category: 'Heritage',
      verificationStatus: VerificationStatus.REJECTED, isApproximate: false,
      yearFrom: 0, yearTo: 2026, sort: 'eventDate', order: 'desc',
    });
    expect(repo.lastParams).toEqual({
      villageId,
      filters: {
        search: 'heritage', category: 'Heritage', verificationStatus: VerificationStatus.REJECTED,
        isApproximate: false, yearFrom: 0, yearTo: 2026,
      },
      sort: { field: 'eventDate', order: 'desc' }, skip: 5, take: 5,
    });
    expect(result.items).toEqual(repo.listResult.items);
    expect(result.meta).toEqual({ page: 2, limit: 5, total: 12, totalPages: 3, hasNextPage: true, hasPrevPage: true });
  });

  it('caps the page size at 100', async () => {
    const result = await new Service(repo).list(villageId, { limit: 500 });
    expect(repo.lastParams?.take).toBe(100);
    expect(result.meta.limit).toBe(100);
  });

  it('returns an empty page beyond the last result without treating the village as missing', async () => {
    repo.listResult = { items: [], total: 1 };
    const result = await new Service(repo).list(villageId, { page: 3, limit: 5 });
    expect(result.items).toEqual([]);
    expect(result.meta).toMatchObject({ total: 1, totalPages: 1, hasNextPage: false, hasPrevPage: true });
  });

  it('returns a standard village 404 when the repository reports a missing/deleted parent', async () => {
    repo.listResult = null;
    await expect(new Service(repo).list(villageId, {})).rejects.toMatchObject({
      statusCode: 404, code: 'NOT_FOUND', message: 'Village not found',
    });
  });

  it.each(Object.values(VerificationStatus))('returns an active %s event without deriving eventYear', async (status) => {
    repo.detail = event(status);
    await expect(new Service(repo).getById(eventId)).resolves.toEqual(repo.detail);
    expect(repo.lastId).toBe(eventId);
    expect(repo.detail.eventYear).toBeNull();
  });

  it('returns a standard event 404 when the event is missing/deleted or its parent is deleted', async () => {
    await expect(new Service(repo).getById(eventId)).rejects.toMatchObject({
      statusCode: 404, code: 'NOT_FOUND', message: 'Historical event not found',
    });
  });

  it('propagates unexpected query failures instead of reporting 404', async () => {
    const failure = new Error('Database unavailable');
    vi.spyOn(repo, 'findMany').mockRejectedValue(failure);
    vi.spyOn(repo, 'findById').mockRejectedValue(failure);
    await expect(new Service(repo).list(villageId, {})).rejects.toBe(failure);
    await expect(new Service(repo).getById(eventId)).rejects.toBe(failure);
  });
});
