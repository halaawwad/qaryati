import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../src/shared/errors.js';

const service = vi.hoisted(() => ({ list: vi.fn(), getById: vi.fn() }));
vi.mock('../src/modules/events/events.service.js', () => ({ eventService: service }));
vi.mock('../src/shared/db.js', () => ({ prisma: {} }));
vi.mock('../src/shared/cache.js', () => ({ redis: {} }));

const villageId = '11111111-1111-4111-8111-111111111111';
const eventId = '22222222-2222-4222-8222-222222222222';
const event = {
  id: eventId, villageId, title: 'حدث تاريخي', description: null, eventYear: null,
  eventDate: new Date('2014-06-20T00:00:00Z'), isApproximate: false, category: null,
  sourceId: null, verificationStatus: 'PENDING', version: 1,
  createdAt: new Date('2026-10-10T00:00:00Z'), updatedAt: new Date('2026-10-10T00:00:00Z'),
};
const meta = { page: 1, limit: 20, total: 1, totalPages: 1, hasNextPage: false, hasPrevPage: false };
let app: Express;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('LOG_LEVEL', 'silent');
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('JWT_ACCESS_SECRET', 'test-secret-with-at-least-32-characters');
  app = (await import('../src/app.js')).createApp();
});

beforeEach(() => {
  vi.resetAllMocks();
  service.list.mockResolvedValue({ items: [event], meta });
  service.getById.mockResolvedValue(event);
});

describe('public event routes', () => {
  it('mounts the nested route without authentication and forwards validated parent and query', async () => {
    const response = await request(app).get(`/api/v1/villages/${villageId}/events`)
      .query({ isApproximate: 'false', yearFrom: '-100', yearTo: '0', search: ' heritage ', category: ' Heritage ' });
    expect(response.status).toBe(200);
    expect(service.list).toHaveBeenCalledWith(villageId, {
      isApproximate: false, yearFrom: -100, yearTo: 0, search: 'heritage', category: 'Heritage',
    });
    expect(response.body).toEqual({ data: [JSON.parse(JSON.stringify(event))], meta });
  });

  it('mounts public detail and serializes dates as ISO strings while preserving nulls', async () => {
    const response = await request(app).get(`/api/v1/events/${eventId}`);
    expect(response.status).toBe(200);
    expect(service.getById).toHaveBeenCalledWith(eventId);
    expect(response.body).toEqual({ data: {
      ...event,
      eventDate: '2014-06-20T00:00:00.000Z',
      createdAt: '2026-10-10T00:00:00.000Z',
      updatedAt: '2026-10-10T00:00:00.000Z',
    } });
    service.getById.mockResolvedValue({ ...event, eventDate: null });
    const undated = await request(app).get(`/api/v1/events/${eventId}`);
    expect(undated.body.data.eventDate).toBeNull();
  });

  it.each([
    '/api/v1/villages/not-a-uuid/events',
    '/api/v1/events/not-a-uuid',
    `/api/v1/villages/${villageId}/events?yearFrom=2026&yearTo=2014`,
    `/api/v1/villages/${villageId}/events?isApproximate=0`,
  ])('returns standard validation errors for %s', async (path) => {
    const response = await request(app).get(path);
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR', requestId: expect.any(String) });
    expect(service.list).not.toHaveBeenCalled();
    expect(service.getById).not.toHaveBeenCalled();
  });

  it('returns HTTP 200 with an empty data array and pagination metadata', async () => {
    const emptyMeta = { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false };
    service.list.mockResolvedValue({ items: [], meta: emptyMeta });

    const response = await request(app).get(`/api/v1/villages/${villageId}/events`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [], meta: emptyMeta });
  });

  it.each([
    `/api/v1/villages/${villageId}/events`,
    `/api/v1/events/${eventId}`,
  ])('returns the standard HTTP 500 envelope for an unexpected service error at %s', async (path) => {
    const failure = new Error('Internal database failure');
    service.list.mockRejectedValue(failure);
    service.getById.mockRejectedValue(failure);

    const response = await request(app).get(path);

    expect(response.status).toBe(500);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        details: [],
        requestId: response.headers['x-request-id'],
      },
    });
  });

  it('uses the shared 404 envelope for missing villages and events', async () => {
    service.list.mockRejectedValue(new NotFoundError('Village not found'));
    service.getById.mockRejectedValue(new NotFoundError('Historical event not found'));
    for (const path of [`/api/v1/villages/${villageId}/events`, `/api/v1/events/${eventId}`]) {
      const response = await request(app).get(path);
      expect(response.status).toBe(404);
      expect(response.body.error).toMatchObject({ code: 'NOT_FOUND', requestId: response.headers['x-request-id'] });
    }
  });
});
