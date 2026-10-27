import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/shared/errors.js';

const service = vi.hoisted(() => ({ list: vi.fn(), getById: vi.fn(), updateRole: vi.fn(), updateStatus: vi.fn() }));
vi.mock('../src/modules/users/users.service.js', () => ({ userService: service }));
vi.mock('../src/shared/db.js', () => ({ prisma: {} }));
vi.mock('../src/shared/cache.js', () => ({ redis: {} }));

const secret = 'test-secret-with-at-least-32-characters';
const actorId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const user = {
  id, email: 'user@example.test', fullName: 'Test User', role: 'EDITOR', isActive: true,
  createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z',
};
const meta = { page: 1, limit: 20, total: 1, totalPages: 1, hasNextPage: false, hasPrevPage: false };
const endpoints = [
  { method: 'get', path: '/api/v1/users', body: undefined },
  { method: 'get', path: `/api/v1/users/${id}`, body: undefined },
  { method: 'patch', path: `/api/v1/users/${id}/role`, body: { role: 'REVIEWER' } },
  { method: 'patch', path: `/api/v1/users/${id}/status`, body: { isActive: false } },
] as const;
let app: Express;
function token(role = 'ADMIN') {
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
  service.list.mockResolvedValue({ items: [user], meta });
  service.getById.mockResolvedValue(user);
  service.updateRole.mockResolvedValue({ ...user, role: 'REVIEWER' });
  service.updateStatus.mockResolvedValue({ ...user, isActive: false });
});

describe('admin user routes', () => {
  it.each(endpoints)('requires authentication for $method $path', async ({ method, path, body }) => {
    const response = await request(app)[method](path).send(body);
    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({ code: 'UNAUTHORIZED', requestId: expect.any(String) });
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it.each(endpoints)('rejects EDITOR and REVIEWER for $method $path', async ({ method, path, body }) => {
    for (const role of ['EDITOR', 'REVIEWER']) {
      const response = await request(app)[method](path).set('Authorization', `Bearer ${token(role)}`).send(body);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it.each(endpoints)('allows ADMIN for $method $path', async ({ method, path, body }) => {
    const response = await request(app)[method](path).set('Authorization', `Bearer ${token()}`).send(body);
    expect(response.status).toBe(200);
    expect(response.body.data).toBeDefined();
    expect(JSON.stringify(response.body)).not.toMatch(/passwordHash|refreshToken|accessToken/);
  });

  it('forwards validated filters and returns data and meta', async () => {
    const response = await request(app).get('/api/v1/users').set('Authorization', `Bearer ${token()}`)
      .query({ page: '2', limit: '5', role: 'REVIEWER', isActive: 'false', q: ' User ', sort: 'fullName', order: 'asc' });
    expect(response.body).toEqual({ data: [user], meta });
    expect(service.list).toHaveBeenCalledWith({ page: 2, limit: 5, role: 'REVIEWER', isActive: false, q: 'User', sort: 'fullName', order: 'asc' });
  });

  it('forwards the authenticated actor to both updates', async () => {
    await request(app).patch(`/api/v1/users/${id}/role`).set('Authorization', `Bearer ${token()}`).send({ role: 'REVIEWER' });
    await request(app).patch(`/api/v1/users/${id}/status`).set('Authorization', `Bearer ${token()}`).send({ isActive: false });
    expect(service.updateRole).toHaveBeenCalledWith(actorId, id, 'REVIEWER');
    expect(service.updateStatus).toHaveBeenCalledWith(actorId, id, false);
  });

  it.each([
    { method: 'patch', path: `/api/v1/users/${id}/role`, body: { role: 'OWNER' } },
    { method: 'patch', path: `/api/v1/users/${id}/status`, body: { isActive: 'false' } },
    { method: 'patch', path: `/api/v1/users/${id}/status`, body: { isActive: 0 } },
    { method: 'patch', path: `/api/v1/users/${id}/role`, body: {} },
    { method: 'patch', path: `/api/v1/users/${id}/status`, body: {} },
    ...['page=0', 'page=1.5', 'page=abc', 'limit=-1', 'limit=0', 'sort=passwordHash', 'order=sideways', 'isActive=0', 'role=OWNER'].map((query) => ({ method: 'get', path: `/api/v1/users?${query}`, body: undefined })),
    { method: 'get', path: '/api/v1/users/not-a-uuid', body: undefined },
  ] as const)('validates $method $path $body', async ({ method, path, body }) => {
    const response = await request(app)[method as 'get' | 'patch'](path).set('Authorization', `Bearer ${token()}`).send(body);
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR', details: expect.any(Array), requestId: expect.any(String) });
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it('preserves service error codes in the unified envelope', async () => {
    service.updateRole.mockRejectedValue(new AppError(409, 'CANNOT_MODIFY_SELF', 'Cannot change own role'));
    const response = await request(app).patch(`/api/v1/users/${id}/role`).set('Authorization', `Bearer ${token()}`).send({ role: 'EDITOR' });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({ code: 'CANNOT_MODIFY_SELF', details: [], requestId: expect.any(String) });
  });
});
