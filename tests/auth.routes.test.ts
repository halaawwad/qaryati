import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/shared/errors.js';

const service = vi.hoisted(() => ({
  register: vi.fn(), login: vi.fn(), refresh: vi.fn(), logout: vi.fn(), getMe: vi.fn(), verifyAccessToken: vi.fn(),
}));
vi.mock('../src/modules/auth/auth.service.js', () => ({ authService: service }));
vi.mock('../src/shared/db.js', () => ({ prisma: {} }));
vi.mock('../src/shared/cache.js', () => ({ redis: {} }));

const secret = 'test-secret-with-at-least-32-characters';
const userId = '11111111-1111-4111-8111-111111111111';
const publicUser = { id: userId, email: 'hala@example.test', fullName: 'Hala Test', role: 'EDITOR' };
const tokens = { accessToken: 'access-token', refreshToken: 'refresh-token' };
let app: Express;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('LOG_LEVEL', 'silent');
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('JWT_ACCESS_SECRET', secret);
  vi.stubEnv('RATE_LIMIT_ENABLED', 'false');
  app = (await import('../src/app.js')).createApp();
});

beforeEach(() => {
  vi.resetAllMocks();
  service.register.mockResolvedValue(publicUser);
  service.login.mockResolvedValue({ ...tokens, user: publicUser });
  service.refresh.mockResolvedValue(tokens);
  service.logout.mockResolvedValue(undefined);
  service.getMe.mockResolvedValue(publicUser);
  // The real authenticate middleware verifies through the service; keep that behaviour.
  service.verifyAccessToken.mockImplementation((token: string) => {
    const payload = jwt.verify(token, secret) as jwt.JwtPayload;
    return { id: payload.sub, role: payload.role };
  });
});

function accessToken(role = 'EDITOR') {
  return jwt.sign({ role }, secret, { subject: userId, expiresIn: '15m', algorithm: 'HS256' });
}

describe('POST /api/v1/auth/register', () => {
  it('creates an account and returns the public user with 201', async () => {
    const response = await request(app).post('/api/v1/auth/register')
      .send({ email: '  hala@example.test ', password: 'long-enough', fullName: ' Hala Test ' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ user: publicUser });
    expect(service.register).toHaveBeenCalledWith({ email: 'hala@example.test', password: 'long-enough', fullName: 'Hala Test' });
  });

  it.each([
    [{ password: 'long-enough', fullName: 'Hala' }, 'body.email'],
    [{ email: 'not-an-email', password: 'long-enough', fullName: 'Hala' }, 'body.email'],
    [{ email: 'hala@example.test', password: 'short', fullName: 'Hala' }, 'body.password'],
    [{ email: 'hala@example.test', password: 'long-enough', fullName: '   ' }, 'body.fullName'],
  ])('rejects invalid input %j without calling the service', async (body, field) => {
    const response = await request(app).post('/api/v1/auth/register').send(body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details).toContainEqual({ field, message: expect.any(String) });
    expect(service.register).not.toHaveBeenCalled();
  });

  it('ignores a role sent by the client', async () => {
    await request(app).post('/api/v1/auth/register')
      .send({ email: 'hala@example.test', password: 'long-enough', fullName: 'Hala', role: 'ADMIN' });

    expect(service.register.mock.calls[0]?.[0]).not.toHaveProperty('role');
  });

  it('passes service errors through in the unified shape', async () => {
    service.register.mockRejectedValue(new AppError(409, 'EMAIL_TAKEN', 'Email is already registered'));

    const response = await request(app).post('/api/v1/auth/register')
      .send({ email: 'hala@example.test', password: 'long-enough', fullName: 'Hala' });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({ code: 'EMAIL_TAKEN', requestId: expect.any(String) });
  });
});

describe('POST /api/v1/auth/login', () => {
  it('returns tokens and the user with 200', async () => {
    const response = await request(app).post('/api/v1/auth/login').send({ email: 'hala@example.test', password: 'secret' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ...tokens, user: publicUser });
  });

  it('rejects a missing password without calling the service', async () => {
    const response = await request(app).post('/api/v1/auth/login').send({ email: 'hala@example.test' });

    expect(response.status).toBe(400);
    expect(response.body.error.details).toContainEqual({ field: 'body.password', message: expect.any(String) });
    expect(service.login).not.toHaveBeenCalled();
  });

  it('returns 401 for wrong credentials', async () => {
    service.login.mockRejectedValue(new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password'));

    const response = await request(app).post('/api/v1/auth/login').send({ email: 'hala@example.test', password: 'wrong' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('POST /api/v1/auth/refresh', () => {
  it('returns a new token pair', async () => {
    const response = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'old-refresh' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(tokens);
    expect(service.refresh).toHaveBeenCalledWith({ refreshToken: 'old-refresh' });
  });

  it('requires a refresh token', async () => {
    const response = await request(app).post('/api/v1/auth/refresh').send({});
    expect(response.status).toBe(400);
    expect(service.refresh).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('revokes the refresh token and returns 204 with no body', async () => {
    const response = await request(app).post('/api/v1/auth/logout').send({ refreshToken: 'refresh-token' });

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(service.logout).toHaveBeenCalledWith({ refreshToken: 'refresh-token' });
  });

  it('requires a refresh token', async () => {
    const response = await request(app).post('/api/v1/auth/logout').send({ refreshToken: '' });
    expect(response.status).toBe(400);
    expect(service.logout).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/auth/me', () => {
  it('requires a bearer token', async () => {
    const response = await request(app).get('/api/v1/auth/me');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(service.getMe).not.toHaveBeenCalled();
  });

  it('returns the signed-in user', async () => {
    const response = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${accessToken()}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ user: publicUser });
    expect(service.getMe).toHaveBeenCalledWith(userId);
  });
});
