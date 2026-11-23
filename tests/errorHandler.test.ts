import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock('../src/shared/logger.js', () => ({ logger }));
vi.mock('../src/shared/db.js', () => ({ prisma: { $queryRaw: vi.fn().mockResolvedValue([1]) } }));
vi.mock('../src/shared/cache.js', () => ({ redis: { ping: vi.fn().mockResolvedValue('PONG') } }));

const baseEnv = {
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'test-secret-with-at-least-32-characters',
  RATE_LIMIT_ENABLED: 'false',
};

type Errors = typeof import('../src/shared/errors.js');

/**
 * Builds a small app that throws an error, wired like the real app (requestId -> json -> errorHandler).
 * Modules are reloaded per NODE_ENV, so AppError subclasses must come from the same fresh import.
 */
async function appThrowing(make: unknown | ((errors: Errors) => unknown), nodeEnv = 'test'): Promise<Express> {
  vi.resetModules();
  for (const [name, value] of Object.entries({ ...baseEnv, NODE_ENV: nodeEnv })) vi.stubEnv(name, value);
  const errors = await import('../src/shared/errors.js');
  const error = typeof make === 'function' ? (make as (e: Errors) => unknown)(errors) : make;
  const { errorHandler } = await import('../src/shared/middlewares/errorHandler.js');
  const { requestId } = await import('../src/shared/middlewares/requestId.js');
  const app = express();
  app.use(requestId);
  app.use(express.json({ limit: '1kb' }));
  app.post('/boom', () => { throw error; });
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  logger.error.mockReset();
});

describe('errorHandler', () => {
  it('returns the unified error shape for an AppError', async () => {
    const app = await appThrowing(({ ConflictError }: Errors) => new ConflictError('Version mismatch', [{ field: 'version', message: 'stale' }]));

    const response = await request(app).post('/boom').set('X-Request-Id', 'req-123');

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: { code: 'CONFLICT', message: 'Version mismatch', details: [{ field: 'version', message: 'stale' }], requestId: 'req-123' },
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('turns a ZodError into VALIDATION_ERROR with dotted field paths', async () => {
    const result = z.object({ village: z.object({ population: z.number().positive() }) }).safeParse({ village: { population: -1 } });
    const app = await appThrowing(result.error);

    const response = await request(app).post('/boom');

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'village.population', message: expect.any(String) }],
    });
  });

  it('returns INVALID_JSON for a malformed body', async () => {
    const app = await appThrowing(new Error('unused'));
    const response = await request(app).post('/boom').set('Content-Type', 'application/json').send('{"name":');
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'INVALID_JSON', message: 'Malformed JSON in request body', details: [] });
  });

  it('returns PAYLOAD_TOO_LARGE for a body over the limit', async () => {
    const app = await appThrowing(new Error('unused'));
    const response = await request(app).post('/boom').send({ text: 'x'.repeat(2048) });
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('maps other exposed 4xx HTTP errors to BAD_REQUEST with their status', async () => {
    const app = await appThrowing(Object.assign(new Error('Unsupported charset'), { status: 415, expose: true }));
    const response = await request(app).post('/boom');
    expect(response.status).toBe(415);
    expect(response.body.error).toMatchObject({ code: 'BAD_REQUEST', message: 'Unsupported charset' });
  });

  it.each([
    ['a plain Error', new Error('secret database detail')],
    ['a non-Error value', { reason: 'secret odd value' }],
    ['a 5xx HTTP error', Object.assign(new Error('upstream detail'), { status: 502 })],
    ['a 4xx error marked as not exposable', Object.assign(new Error('internal detail'), { status: 400, expose: false })],
  ])('hides %s behind a generic 500 and logs it', async (_label, error) => {
    const app = await appThrowing(error, 'production');

    const response = await request(app).post('/boom');

    expect(response.status).toBe(500);
    expect(response.body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Internal server error', details: [] });
    expect(response.body.error.stack).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toMatch(/secret|upstream|internal detail/);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('includes the stack for 500 errors only in development', async () => {
    const devApp = await appThrowing(new Error('dev failure'), 'development');
    const dev = await request(devApp).post('/boom');
    expect(dev.body.error.stack).toContain('dev failure');

    const notFoundApp = await appThrowing(({ NotFoundError }: Errors) => new NotFoundError(), 'development');
    const notFound = await request(notFoundApp).post('/boom');
    expect(notFound.status).toBe(404);
    expect(notFound.body.error.stack).toBeUndefined();
  });

  it('generates a request ID when the client sends an unsafe one', async () => {
    const app = await appThrowing(({ NotFoundError }: Errors) => new NotFoundError());

    const response = await request(app).post('/boom').set('X-Request-Id', 'bad id with spaces');

    expect(response.body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers['x-request-id']).toBe(response.body.error.requestId);
  });
});
