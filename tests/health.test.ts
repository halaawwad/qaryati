import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  prisma: { $queryRaw: vi.fn() },
  redis: { ping: vi.fn() },
}));
vi.mock('../src/shared/db.js', () => ({ prisma: mocks.prisma }));
vi.mock('../src/shared/cache.js', () => ({ redis: mocks.redis }));

let app: Express;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('LOG_LEVEL', 'silent');
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('JWT_ACCESS_SECRET', 'test-secret-with-at-least-32-characters');
  vi.stubEnv('RATE_LIMIT_ENABLED', 'false');
  app = (await import('../src/app.js')).createApp();
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
  mocks.redis.ping.mockResolvedValue('PONG');
});

describe('GET /api/v1/health', () => {
  it('returns 200 when the database and Redis respond', async () => {
    const response = await request(app).get('/api/v1/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', db: 'up', redis: 'up' });
    expect(mocks.prisma.$queryRaw).toHaveBeenCalledOnce();
    expect(mocks.redis.ping).toHaveBeenCalledOnce();
  });

  it('returns 503 when the database is down', async () => {
    mocks.prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

    const response = await request(app).get('/api/v1/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'error', db: 'down', redis: 'up' });
  });

  it('returns 503 when Redis is down', async () => {
    mocks.redis.ping.mockRejectedValue(new Error('ECONNREFUSED'));

    const response = await request(app).get('/api/v1/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'error', db: 'up', redis: 'down' });
  });

  it('does not leak dependency error messages', async () => {
    mocks.prisma.$queryRaw.mockRejectedValue(new Error('password authentication failed for user "qaryati"'));
    mocks.redis.ping.mockRejectedValue(new Error('NOAUTH Authentication required'));

    const response = await request(app).get('/api/v1/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'error', db: 'down', redis: 'down' });
  });

  it('reports a dependency that hangs as down after the timeout', async () => {
    mocks.redis.ping.mockReturnValue(new Promise(() => {}));

    const started = Date.now();
    const response = await request(app).get('/api/v1/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'error', db: 'up', redis: 'down' });
    expect(Date.now() - started).toBeLessThan(4000);
  }, 6000);

  it('does not require authentication', async () => {
    const response = await request(app).get('/api/v1/health').set('Authorization', 'Bearer not-a-real-token');
    expect(response.status).toBe(200);
  });
});

describe('unknown routes', () => {
  it('return the unified 404 error shape', async () => {
    const response = await request(app).get('/api/v1/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({
      code: 'NOT_FOUND', message: 'Route GET /api/v1/does-not-exist not found', details: [], requestId: expect.any(String),
    });
  });
});
