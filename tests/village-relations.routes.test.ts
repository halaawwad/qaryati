import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Route-level checks of who may call the alternate-name and nearby-place endpoints. The real authenticate and
// requireRole run; the service is mocked, so only the routing and the role guard are tested here.
const service = vi.hoisted(() => ({
  addName: vi.fn(),
  updateName: vi.fn(),
  removeName: vi.fn(),
  addNearby: vi.fn(),
  removeNearby: vi.fn(),
}));
vi.mock('../src/modules/villages/village-relations.service.js', () => ({ villageRelationsService: service }));
vi.mock('../src/shared/db.js', () => ({ prisma: {} }));
vi.mock('../src/shared/cache.js', () => ({ redis: {} }));

const secret = 'test-secret-with-at-least-32-characters';
const actorId = '11111111-1111-4111-8111-111111111111';
const villageId = '22222222-2222-4222-8222-222222222222';
const nameId = '33333333-3333-4333-8333-333333333333';
const relationId = '44444444-4444-4444-8444-444444444444';
const relatedVillageId = '55555555-5555-4555-8555-555555555555';

const deleteName = `/api/v1/villages/${villageId}/names/${nameId}`;
const deleteNearby = `/api/v1/villages/${villageId}/nearby/${relationId}`;
let app: Express;

function token(role: string): string {
  return jwt.sign({ role }, secret, { subject: actorId, expiresIn: '15m', algorithm: 'HS256' });
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('LOG_LEVEL', 'silent');
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('JWT_ACCESS_SECRET', secret);
  app = (await import('../src/app.js')).createApp();
});

beforeEach(() => {
  vi.resetAllMocks();
  service.addName.mockResolvedValue({ id: nameId });
  service.updateName.mockResolvedValue({ id: nameId });
  service.removeName.mockResolvedValue(undefined);
  service.addNearby.mockResolvedValue({ id: relationId });
  service.removeNearby.mockResolvedValue(undefined);
});

describe.each([
  { what: 'an alternate name', path: deleteName, removed: service.removeName, id: nameId },
  { what: 'a nearby place', path: deleteNearby, removed: service.removeNearby, id: relationId },
])('DELETE $what is ADMIN only', ({ path, removed, id }) => {
  it('returns 401 without a token', async () => {
    const response = await request(app).delete(path);

    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({ code: 'UNAUTHORIZED', requestId: expect.any(String) });
    expect(removed).not.toHaveBeenCalled();
  });

  it.each(['EDITOR', 'REVIEWER'])('returns 403 FORBIDDEN for a %s, and does not call the service', async (role) => {
    const response = await request(app).delete(path).set('Authorization', `Bearer ${token(role)}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(removed).not.toHaveBeenCalled();
  });

  it('returns 204 for an ADMIN, and passes the actor with the role to the service', async () => {
    const response = await request(app).delete(path).set('Authorization', `Bearer ${token('ADMIN')}`);

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls[0]).toEqual([
      villageId,
      id,
      expect.objectContaining({ userId: actorId, role: 'ADMIN' }),
    ]);
  });
});

describe('the other alternate-name and nearby-place endpoints are unchanged', () => {
  const calls = [
    { name: 'POST names', method: 'post', path: `/api/v1/villages/${villageId}/names`, body: { name: 'Bayta', language: 'en', nameType: 'TRANSLITERATION' }, status: 201 },
    { name: 'PATCH names', method: 'patch', path: deleteName, body: { version: 1, periodFrom: 1900 }, status: 200 },
    { name: 'POST nearby', method: 'post', path: `/api/v1/villages/${villageId}/nearby`, body: { relatedVillageId, relation: 'NEARBY' }, status: 201 },
  ] as const;

  it.each(calls)('$name still allows an EDITOR, a REVIEWER and an ADMIN', async ({ method, path, body, status }) => {
    for (const role of ['EDITOR', 'REVIEWER', 'ADMIN']) {
      const response = await request(app)[method](path).set('Authorization', `Bearer ${token(role)}`).send(body);
      expect(response.status).toBe(status);
    }
  });

  it.each(calls)('$name still requires authentication', async ({ method, path, body }) => {
    const response = await request(app)[method](path).send(body);

    expect(response.status).toBe(401);
  });
});
