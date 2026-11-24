import type { Express } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError, ConflictError, NotFoundError } from '../src/shared/errors.js';
import { applyGeoEnrichmentSchema } from '../src/modules/villages/villages.schemas.js';
const service = vi.hoisted(() => ({ candidates: vi.fn(), apply: vi.fn() }));
vi.mock('../src/modules/villages/villages.geo.service.js', () => ({ villageGeoService: service }));
vi.mock('../src/shared/db.js', () => ({ prisma: {} }));
vi.mock('../src/shared/cache.js', () => ({ redis: {} }));
const id = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const body = { candidateRef: '33333333-3333-4333-8333-333333333333', version: 1, confirm: true };
const path = '/api/v1/villages/' + id;
const secret = 'test-secret-with-at-least-32-characters';
let app: Express;
beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('LOG_LEVEL', 'silent'); vi.stubEnv('RATE_LIMIT_ENABLED', 'false');
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost/test'); vi.stubEnv('REDIS_URL', 'redis://localhost:6379'); vi.stubEnv('JWT_ACCESS_SECRET', secret);
  app = (await import('../src/app.js')).createApp();
});
beforeEach(() => {
  vi.resetAllMocks(); service.candidates.mockResolvedValue({ villageId: id, version: 1, status: 'no_match', candidates: [] });
  service.apply.mockResolvedValue({ id, version: 2 });
});
const auth = (role = 'REVIEWER') => 'Bearer ' + jwt.sign({ role }, secret, { subject: actorId, expiresIn: '15m' });
describe('village geo routes', () => {
  it.each(['ADMIN', 'REVIEWER'])('allows %s to retrieve candidates and explicitly apply one', async role => {
    const candidates = await request(app).get(path + '/geo-candidates').set('Authorization', auth(role));
    expect(candidates.status).toBe(200); expect(candidates.body.data.status).toBe('no_match');
    const response = await request(app).post(path + '/geo-enrichment').set('Authorization', auth(role)).set('X-Request-Id', 'geo-request').send(body);
    expect(response.status).toBe(200); expect(response.body).toEqual({ data: { id, version: 2 } });
    expect(service.apply).toHaveBeenCalledWith(id, { ...body, overwriteExisting: false }, { actorId, requestId: 'geo-request' });
  });
  it.each([undefined, 'Bearer bad', 'Basic bad'])('requires valid authentication: %s', async authorization => {
    for (const method of ['get', 'post'] as const) {
      const call = request(app)[method](path + (method === 'get' ? '/geo-candidates' : '/geo-enrichment'));
      if (authorization) call.set('Authorization', authorization);
      expect((await call.send(body)).status).toBe(401);
    }
    expect(service.apply).not.toHaveBeenCalled(); expect(service.candidates).not.toHaveBeenCalled();
  });
  it('forbids EDITOR before validation', async () => {
    expect((await request(app).post('/api/v1/villages/bad/geo-enrichment').set('Authorization', auth('EDITOR')).send({})).status).toBe(403);
    expect((await request(app).get(path + '/geo-candidates').set('Authorization', auth('EDITOR'))).status).toBe(403);
    expect(service.apply).not.toHaveBeenCalled();
  });
  it('rejects invalid village UUIDs', async () => {
    expect((await request(app).get('/api/v1/villages/not-a-uuid/geo-candidates').set('Authorization', auth())).status).toBe(400);
    expect(service.candidates).not.toHaveBeenCalled();
  });
  it.each([
    {}, { ...body, candidateRef: 'bad' }, { ...body, version: 0 }, { ...body, version: '1' }, { ...body, version: 1.5 },
    { ...body, confirm: false }, { ...body, confirm: undefined }, { ...body, overwriteExisting: 'true' },
    { ...body, latitude: 31 }, { ...body, longitude: 35 }, { ...body, provider: 'nominatim' },
    { ...body, createdById: actorId }, { ...body, verificationStatus: 'VERIFIED' },
  ])('rejects invalid or protected body %j', async input => {
    const response = await request(app).post(path + '/geo-enrichment').set('Authorization', auth()).send(input);
    expect(response.status).toBe(400); expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR', details: expect.any(Array), requestId: expect.any(String) });
    expect(service.apply).not.toHaveBeenCalled();
  });
  it('strict schema rejects unsafe versions and nonfinite values', () => {
    for (const version of [NaN, Infinity, 2147483647, -1]) expect(applyGeoEnrichmentSchema.safeParse({ ...body, version }).success).toBe(false);
  });
  it.each([
    [new NotFoundError('Village not found'), 404, 'NOT_FOUND'],
    [new ConflictError('Village changed'), 409, 'CONFLICT'],
    [new AppError(400, 'INVALID_GEO_CANDIDATE', 'Candidate expired'), 400, 'INVALID_GEO_CANDIDATE'],
    [new AppError(503, 'GEO_UNAVAILABLE', 'Unavailable'), 503, 'GEO_UNAVAILABLE'],
    [new Error('private provider/database details'), 500, 'INTERNAL_ERROR'],
  ])('uses standard error envelopes: %j', async (error, status, code) => {
    service.apply.mockRejectedValue(error);
    const response = await request(app).post(path + '/geo-enrichment').set('Authorization', auth()).send(body);
    expect(response.status).toBe(status); expect(response.body.error).toMatchObject({ code, details: [], requestId: expect.any(String) });
    expect(JSON.stringify(response.body)).not.toContain('private provider/database details');
  });
  it('preserves body-size middleware', async () => {
    const response = await request(app).post(path + '/geo-enrichment').set('Authorization', auth()).send({ text: 'x'.repeat(1048577) });
    expect(response.status).toBe(413); expect(service.apply).not.toHaveBeenCalled();
  });
});
