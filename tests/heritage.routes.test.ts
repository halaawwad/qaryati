import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../src/shared/errors.js';

const service = vi.hoisted(() => ({ list: vi.fn(), getById: vi.fn() }));
vi.mock('../src/modules/heritage/heritage.service.js', () => ({ heritageService: service }));
vi.mock('../src/shared/db.js', () => ({ prisma: {} }));
vi.mock('../src/shared/cache.js', () => ({ redis: {} }));

const villageId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const listPath = '/api/v1/villages/' + villageId + '/heritage';
const detailPath = '/api/v1/heritage/' + id;
const item = {
  id, villageId, category: 'CRAFT', name: 'صناعة السلال', description: null, sourceId: null,
  verificationStatus: 'PENDING', version: 1,
  createdAt: new Date('2026-10-10T00:00:00Z'), updatedAt: new Date('2026-10-11T00:00:00Z'),
};
const jsonItem = { ...item, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z' };
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
  service.list.mockResolvedValue({ items: [item], meta });
  service.getById.mockResolvedValue(item);
});

describe('public heritage routes', () => {
  it('mounts the nested public route and forwards validated params and query', async () => {
    const response = await request(app).get(listPath).query({
      page: '1', limit: '20', search: '  سلال%_\\  ', category: 'CRAFT',
      verificationStatus: 'PENDING', sort: 'updatedAt', order: 'desc',
    });
    expect(response.status).toBe(200);
    expect(service.list).toHaveBeenCalledWith(villageId, {
      page: 1, limit: 20, search: 'سلال%_\\', category: 'CRAFT',
      verificationStatus: 'PENDING', sort: 'updatedAt', order: 'desc',
    });
    expect(response.body).toEqual({ data: [jsonItem], meta });
  });

  it('returns public detail with ISO timestamps and preserved nulls without authentication', async () => {
    const response = await request(app).get(detailPath);
    expect(response.status).toBe(200);
    expect(service.getById).toHaveBeenCalledWith(id);
    expect(response.body).toEqual({ data: jsonItem });
  });

  it('returns HTTP 200 and the empty list envelope for an active village without matches', async () => {
    const emptyMeta = { ...meta, total: 0, totalPages: 0 };
    service.list.mockResolvedValue({ items: [], meta: emptyMeta });
    const response = await request(app).get(listPath);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [], meta: emptyMeta });
  });

  it.each([
    '/api/v1/villages/not-a-uuid/heritage',
    '/api/v1/heritage/not-a-uuid',
    listPath + '?category=craft',
    listPath + '?verificationStatus=unknown',
    listPath + '?page=0',
    listPath + '?limit=-1',
    listPath + '?sort=category',
  ])('validates before calling the service for %s', async (path) => {
    const response = await request(app).get(path);
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR', requestId: expect.any(String) });
    expect(service.list).not.toHaveBeenCalled();
    expect(service.getById).not.toHaveBeenCalled();
  });

  it.each([listPath, detailPath])('uses the standard 404 envelope for %s', async (path) => {
    service.list.mockRejectedValue(new NotFoundError('Village not found'));
    service.getById.mockRejectedValue(new NotFoundError('Heritage item not found'));
    const response = await request(app).get(path);
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({
      code: 'NOT_FOUND', requestId: response.headers['x-request-id'],
    });
  });

  it.each([listPath, detailPath])('uses the standard 500 envelope for unexpected failures at %s', async (path) => {
    const error = new Error('Internal database failure');
    service.list.mockRejectedValue(error);
    service.getById.mockRejectedValue(error);
    const response = await request(app).get(path);
    expect(response.status).toBe(500);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.body).toEqual({
      error: {
        code: 'INTERNAL_ERROR', message: 'Internal server error', details: [],
        requestId: response.headers['x-request-id'],
      },
    });
  });
});
