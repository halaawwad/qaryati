import { SourceType, VerificationStatus, type Source } from '@prisma/client';
import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  source: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
}));
vi.mock('../src/shared/db.js', () => ({
  prisma: {
    ...db,
    $transaction: (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
  },
}));
vi.mock('../src/shared/cache.js', () => ({ redis: {} }));

const id = '11111111-1111-4111-8111-111111111111';
const deletedId = '22222222-2222-4222-8222-222222222222';
const missingId = '33333333-3333-4333-8333-333333333333';
const source: Source = {
  id, title: 'Reference', author: null, publisher: null, year: null, url: null,
  citationText: null, sourceType: SourceType.BOOK,
  verificationStatus: VerificationStatus.PENDING, version: 1,
  createdById: null, updatedById: null, deletedAt: null,
  createdAt: new Date('2026-11-02T00:00:00Z'), updatedAt: new Date('2026-11-02T00:00:00Z'),
};
const deleted = { ...source, id: deletedId, deletedAt: new Date('2026-11-02T01:00:00Z') };
const rows = [source, deleted];
const select = {
  id: true, title: true, author: true, publisher: true, year: true, url: true,
  sourceType: true, citationText: true, verificationStatus: true, version: true,
  createdAt: true, updatedAt: true,
};
const publicSource = Object.fromEntries(Object.keys(select).map((key) => [key, source[key as keyof Source]]));
const serialized = JSON.parse(JSON.stringify(publicSource));
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
  // The fake applies Prisma's supplied predicates, so deleting the soft-delete
  // predicate from production code would expose the deleted fixture and fail tests.
  const matches = (row: Source, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => value === undefined || row[key as keyof Source] === value);
  const project = (row: Source, fields: Record<string, boolean>) =>
    Object.fromEntries(Object.keys(fields).filter((key) => fields[key]).map((key) => [key, row[key as keyof Source]]));
  db.source.count.mockImplementation(async ({ where }) => rows.filter((row) => matches(row, where)).length);
  db.source.findMany.mockImplementation(async ({ where, skip, take, select: fields }) =>
    rows.filter((row) => matches(row, where)).slice(skip, skip + take).map((row) => project(row, fields)));
  db.source.findFirst.mockImplementation(async ({ where, select: fields }) => {
    const row = rows.find((row) => matches(row, where));
    return row ? project(row, fields) : null;
  });
});

describe('public Sources reads', () => {
  it('lists only active sources with default pagination and stable ordering', async () => {
    const response = await request(app).get('/api/v1/sources');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [serialized], meta: {
      page: 1, limit: 20, total: 1, totalPages: 1, hasNextPage: false, hasPrevPage: false,
    } });
    const where = { deletedAt: null, sourceType: undefined, verificationStatus: undefined };
    expect(db.source.count).toHaveBeenCalledExactlyOnceWith({ where });
    expect(db.source.findMany).toHaveBeenCalledExactlyOnceWith({
      where, skip: 0, take: 20, select, orderBy: [{ title: 'asc' }, { id: 'asc' }],
    });
  });

  it('returns public details, preserving nulls and serializing dates', async () => {
    const response = await request(app).get(`/api/v1/sources/${id}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: serialized });
    expect(db.source.findFirst).toHaveBeenCalledExactlyOnceWith({ where: { id, deletedAt: null }, select });
  });

  it.each([missingId, deletedId])('returns 404 for missing or soft-deleted source %s', async (lookup) => {
    const response = await request(app).get(`/api/v1/sources/${lookup}`);
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({
      code: 'NOT_FOUND', message: 'Source not found', requestId: response.headers['x-request-id'],
    });
  });

  it.each([
    [{ sourceType: 'BOOK' }, 1],
    [{ sourceType: 'WEBSITE' }, 0],
    [{ verificationStatus: 'PENDING' }, 1],
    [{ verificationStatus: 'VERIFIED' }, 0],
    [{ sourceType: 'BOOK', verificationStatus: 'PENDING' }, 1],
    [{ sourceType: 'BOOK', verificationStatus: 'REJECTED' }, 0],
  ])('filters list and total by %j', async (query, total) => {
    const response = await request(app).get('/api/v1/sources').query(query);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(total ? [serialized] : []);
    expect(response.body.meta.total).toBe(total);
    expect(db.source.count.mock.calls[0]?.[0].where).toEqual({ deletedAt: null, ...query });
  });

  it('coerces page and limit and returns an empty out-of-range page with the correct total', async () => {
    const response = await request(app).get('/api/v1/sources?page=2&limit=1');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [], meta: {
      page: 2, limit: 1, total: 1, totalPages: 1, hasNextPage: false, hasPrevPage: true,
    } });
    expect(db.source.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 1, take: 1 }));
  });

  it('caps the page size at 100 before calculating the offset', async () => {
    const response = await request(app).get('/api/v1/sources?page=2&limit=999');
    expect(response.status).toBe(200);
    expect(response.body.meta.limit).toBe(100);
    expect(db.source.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 100, take: 100 }));
  });

  it.each([
    '/api/v1/sources/not-a-uuid', '/api/v1/sources?page=0', '/api/v1/sources?page=1.5',
    '/api/v1/sources?limit=-1', '/api/v1/sources?limit=abc',
    '/api/v1/sources?sourceType=INVALID', '/api/v1/sources?verificationStatus=INVALID',
  ])('rejects invalid input before database access: %s', async (path) => {
    const response = await request(app).get(path);
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR', requestId: expect.any(String) });
    expect(db.source.findMany).not.toHaveBeenCalled();
    expect(db.source.count).not.toHaveBeenCalled();
    expect(db.source.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    { page: 2_147_483_648, limit: 1, skip: 2_147_483_647, take: 1 },
    { page: 107_374_183, limit: undefined, skip: 2_147_483_640, take: 20 },
    { page: 21_474_837, limit: 100, skip: 2_147_483_600, take: 100 },
    { page: 21_474_837, limit: 999, skip: 2_147_483_600, take: 100 },
    { page: 3, limit: 5, skip: 10, take: 5 },
  ])('accepts supported offsets using the effective limit: %j', async ({ page, limit, skip, take }) => {
    const query = limit === undefined ? { page } : { page, limit };
    const response = await request(app).get('/api/v1/sources').query(query);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [], meta: {
      page, limit: take, total: 1, totalPages: Math.ceil(1 / take),
      hasNextPage: false, hasPrevPage: true,
    } });
    expect(db.source.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip, take }));
  });

  it.each([
    { page: 2_147_483_649, limit: 1 },
    { page: 107_374_184 },
    { page: 21_474_838, limit: 100 },
    { page: 21_474_838, limit: 999 },
    { page: 2_147_483_648, limit: 2 },
    { page: Number.MAX_SAFE_INTEGER, limit: 100 },
    { page: '9007199254740992', limit: 100 },
    { page: '1e100', limit: 100 },
  ])('rejects unsupported or unsafe offsets before Prisma access: %j', async (query) => {
    const response = await request(app).get('/api/v1/sources').query(query);
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_ERROR', requestId: response.headers['x-request-id'],
      details: expect.arrayContaining([expect.objectContaining({ field: 'query.page' })]),
    });
    expect(db.source.count).not.toHaveBeenCalled();
    expect(db.source.findMany).not.toHaveBeenCalled();
    expect(db.source.findFirst).not.toHaveBeenCalled();
  });

  it.each(['list', 'detail'])('propagates %s database errors through the shared handler', async (operation) => {
    const error = new Error('Database unavailable');
    db.source.count.mockRejectedValue(error);
    db.source.findFirst.mockRejectedValue(error);
    const response = await request(app).get(operation === 'list' ? '/api/v1/sources' : `/api/v1/sources/${id}`);
    expect(response.status).toBe(500);
    expect(response.body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
  });
});
