import { createHash } from 'node:crypto';
import express from 'express';
import { MemoryStore } from 'express-rate-limit';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/shared/errors.js';

const mocks = vi.hoisted(() => ({
  auth: { login: vi.fn(), register: vi.fn(), refresh: vi.fn() },
  redis: { ping: vi.fn(), call: vi.fn() },
  prisma: { $queryRaw: vi.fn() },
  logger: { warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/modules/auth/auth.service.js', () => ({ authService: mocks.auth }));
vi.mock('../src/shared/cache.js', () => ({ redis: mocks.redis }));
vi.mock('../src/shared/db.js', () => ({ prisma: mocks.prisma }));

const credentials = { email: 'person@example.test', password: 'wrong-password' };
const registration = { ...credentials, fullName: 'Test User' };

async function appWith(overrides: Record<string, string> = {}) {
  for (const [name, value] of Object.entries(overrides)) vi.stubEnv(name, value);
  return (await import('../src/app.js')).createApp();
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  const environment = {
    NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379', JWT_ACCESS_SECRET: 'test-secret-with-at-least-32-characters',
    RATE_LIMIT_ENABLED: 'true', TRUST_PROXY: 'false', RATE_LIMIT_WINDOW_MINUTES: '15', RATE_LIMIT_MAX: '300',
    LOGIN_RATE_LIMIT_WINDOW_MINUTES: '15', LOGIN_RATE_LIMIT_MAX: '5',
    REGISTER_RATE_LIMIT_WINDOW_MINUTES: '60', REGISTER_RATE_LIMIT_MAX: '10',
    REFRESH_RATE_LIMIT_WINDOW_MINUTES: '15', REFRESH_RATE_LIMIT_MAX: '30',
  };
  for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
  mocks.auth.login.mockRejectedValue(new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password'));
  mocks.auth.register.mockResolvedValue({ id: 'user', role: 'EDITOR' });
  mocks.auth.refresh.mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh' });
  mocks.redis.ping.mockResolvedValue('PONG');
  mocks.prisma.$queryRaw.mockResolvedValue([1]);
});

describe('rate limiting through the mounted API', () => {
  it('returns unified 429 and Retry-After on the sixth failed login, allowing another email', async () => {
    const app = await appWith();
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await request(app).post('/api/v1/auth/login').send(credentials)).status).toBe(401);
    }
    const blocked = await request(app).post('/api/v1/auth/login').send(credentials);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: {
      code: 'TOO_MANY_REQUESTS', message: 'Too many requests; please try again later', details: [],
      requestId: blocked.headers['x-request-id'],
    } });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers.ratelimit).toContain('limit=5');
    expect(blocked.headers['ratelimit-policy']).toBe('5;w=900');
    expect(mocks.auth.login).toHaveBeenCalledTimes(5);
    const other = await request(app).post('/api/v1/auth/login').send({ ...credentials, email: 'different@example.test' });
    expect(other.status).toBe(401);
    expect(mocks.redis.call).not.toHaveBeenCalled();
  });

  it('does not count successful logins against the failure quota', async () => {
    const app = await appWith();
    mocks.auth.login.mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh' });
    for (let attempt = 0; attempt < 7; attempt++) {
      expect((await request(app).post('/api/v1/auth/login').send(credentials)).status).toBe(200);
    }
    mocks.auth.login.mockRejectedValue(new AppError(401, 'INVALID_CREDENTIALS', 'Invalid credentials'));
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await request(app).post('/api/v1/auth/login').send(credentials)).status).toBe(401);
    }
    expect((await request(app).post('/api/v1/auth/login').send(credentials)).status).toBe(429);
  });

  it('counts 403 inactive-user login failures', async () => {
    const app = await appWith();
    mocks.auth.login.mockRejectedValue(new AppError(403, 'FORBIDDEN', 'User account is inactive'));
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await request(app).post('/api/v1/auth/login').send(credentials)).status).toBe(403);
    }
    expect((await request(app).post('/api/v1/auth/login').send(credentials)).status).toBe(429);
  });

  it('shares the quota across email case and surrounding whitespace variations', async () => {
    const app = await appWith();
    for (let attempt = 0; attempt < 5; attempt++) {
      await request(app).post('/api/v1/auth/login').send(credentials);
    }
    const response = await request(app).post('/api/v1/auth/login').send({ ...credentials, email: ' PERSON@EXAMPLE.TEST ' });
    expect(response.status).toBe(429);
  });

  it.each([
    { path: 'register', max: 10, body: registration, success: 201, window: 3600 },
    { path: 'refresh', max: 30, body: { refreshToken: 'opaque-token' }, success: 200, window: 900 },
  ])('limits $path requests after their default maximum', async ({ path, max, body, success, window }) => {
    const app = await appWith();
    for (let attempt = 0; attempt < max; attempt++) {
      expect((await request(app).post(`/api/v1/auth/${path}`).send(body)).status).toBe(success);
    }
    const response = await request(app).post(`/api/v1/auth/${path}`).send(body);
    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(response.headers['retry-after']).toBeDefined();
    expect(response.headers['ratelimit-policy']).toBe(`${max};w=${window}`);
  });

  it('limits all API requests after RATE_LIMIT_MAX and keeps health available without consuming quota', async () => {
    const app = await appWith({ RATE_LIMIT_MAX: '2' });
    for (let attempt = 0; attempt < 4; attempt++) {
      const health = await request(app).get('/api/v1/health');
      expect(health.status).toBe(200);
      expect(health.headers.ratelimit).toBeUndefined();
    }
    // Unmatched API routes also consume the global quota.
    expect((await request(app).get('/api/v1/missing')).status).toBe(404);
    expect((await request(app).get('/api/v1/missing')).status).toBe(404);
    const blocked = await request(app).get('/api/v1/missing');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(blocked.headers.ratelimit).toContain('limit=2');
    expect(blocked.headers['retry-after']).toBeDefined();
    for (const path of ['/api/v1/health', '/api/v1/health/', '/api/v1/health?probe=1']) {
      expect((await request(app).get(path)).status).toBe(200);
    }
  });

  it('disables all limiters with RATE_LIMIT_ENABLED=false', async () => {
    const app = await appWith({ RATE_LIMIT_ENABLED: 'false', RATE_LIMIT_MAX: '1',
      LOGIN_RATE_LIMIT_MAX: '1', REGISTER_RATE_LIMIT_MAX: '1', REFRESH_RATE_LIMIT_MAX: '1' });
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await request(app).post('/api/v1/auth/login').send(credentials)).status).toBe(401);
      expect((await request(app).post('/api/v1/auth/register').send(registration)).status).toBe(201);
      expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'token' })).status).toBe(200);
      const response = await request(app).get('/api/v1/missing');
      expect(response.status).toBe(404);
      expect(response.headers.ratelimit).toBeUndefined();
    }
    expect(mocks.redis.call).not.toHaveBeenCalled();
  });

  it('uses configured windows and maxima rather than hardcoded defaults', async () => {
    const app = await appWith({ RATE_LIMIT_WINDOW_MINUTES: '2', LOGIN_RATE_LIMIT_WINDOW_MINUTES: '3',
      REGISTER_RATE_LIMIT_WINDOW_MINUTES: '4', REFRESH_RATE_LIMIT_WINDOW_MINUTES: '5',
      LOGIN_RATE_LIMIT_MAX: '1', REGISTER_RATE_LIMIT_MAX: '1', REFRESH_RATE_LIMIT_MAX: '1' });
    const global = await request(app).get('/api/v1/missing');
    expect(global.headers['ratelimit-policy']).toBe('300;w=120');
    for (const [path, body, seconds] of [
      ['login', credentials, 180], ['register', registration, 240], ['refresh', { refreshToken: 'token' }, 300],
    ] as const) {
      await request(app).post(`/api/v1/auth/${path}`).send(body);
      const response = await request(app).post(`/api/v1/auth/${path}`).send(body);
      expect(response.status).toBe(429);
      expect(response.headers['ratelimit-policy']).toBe(`1;w=${seconds}`);
    }
  });

  it('applies TRUST_PROXY and groups forwarded requests by client IP', async () => {
    const app = await appWith({ TRUST_PROXY: 'true', RATE_LIMIT_MAX: '1' });
    expect(app.get('trust proxy')).toBe(true);
    expect((await request(app).get('/api/v1/missing').set('X-Forwarded-For', '192.0.2.1')).status).toBe(404);
    expect((await request(app).get('/api/v1/missing').set('X-Forwarded-For', '192.0.2.1')).status).toBe(429);
    expect((await request(app).get('/api/v1/missing').set('X-Forwarded-For', '192.0.2.2')).status).toBe(404);
  });
});

describe('store failure and key privacy', () => {
  async function fixture(store: MemoryStore, kind: 'global' | 'login' = 'global') {
    const { logger } = await import('../src/shared/logger.js');
    vi.spyOn(logger, 'warn').mockImplementation(mocks.logger.warn);
    const { createRateLimiter } = await import('../src/shared/middlewares/rateLimit.js');
    const { errorHandler } = await import('../src/shared/middlewares/errorHandler.js');
    const { requestId } = await import('../src/shared/middlewares/requestId.js');
    const app = express();
    app.use(requestId, express.json(), createRateLimiter(kind, store));
    app.post('/', (_req, res) => res.status(200).json({ ok: true }));
    app.use(errorHandler);
    return app;
  }

  it('allows requests on store increment failure and logs a warning without sensitive error details', async () => {
    const store = new MemoryStore();
    vi.spyOn(store, 'increment').mockRejectedValue(new Error('private email/key/password must not be logged'));
    const app = await fixture(store);
    const response = await request(app).post('/').send(credentials);
    expect(response.status).toBe(200);
    expect(mocks.logger.warn.mock.calls).toEqual([['Rate limit store unavailable; allowing requests without strict limits']]);
    store.shutdown();
  });

  it('allows requests when asynchronous store initialization fails without an unhandled rejection', async () => {
    const store = new MemoryStore();
    vi.spyOn(store, 'init').mockRejectedValue(new Error('private initialization details'));
    vi.spyOn(store, 'increment').mockRejectedValue(new Error('store unavailable'));
    const app = await fixture(store);
    expect((await request(app).post('/').send(credentials)).status).toBe(200);
    expect(mocks.logger.warn).toHaveBeenCalledWith('Rate limit store unavailable; allowing requests without strict limits');
    store.shutdown();
  });

  it('catches post-response decrement failures instead of crashing on a successful login', async () => {
    const store = new MemoryStore();
    vi.spyOn(store, 'decrement').mockRejectedValue(new Error('private derived key'));
    const app = await fixture(store, 'login');
    expect((await request(app).post('/').send(credentials)).status).toBe(200);
    expect(mocks.logger.warn).toHaveBeenCalledWith('Rate limit store unavailable; allowing requests without strict limits');
    store.shutdown();
  });

  it('passes only the IP and SHA-256 of normalized email to the store', async () => {
    const store = new MemoryStore();
    const increment = vi.spyOn(store, 'increment');
    const app = await fixture(store, 'login');
    await request(app).post('/').send({ ...credentials, email: ' PERSON@EXAMPLE.TEST ' });
    const key = increment.mock.calls[0]?.[0];
    const hash = createHash('sha256').update(credentials.email).digest('hex');
    expect(key).toMatch(new RegExp(`:${hash}$`));
    expect(key).not.toContain('person');
    expect(key).not.toContain('@');
    expect(key).not.toContain(credentials.password);
    store.shutdown();
  });
});
