import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/shared/errors.js';
import { requireRole } from '../src/shared/middlewares/requireRole.js';

let authenticate: typeof import('../src/shared/middlewares/authenticate.js').authenticate;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('JWT_ACCESS_SECRET', 'test-secret-with-at-least-32-characters');
  vi.stubEnv('JWT_ACCESS_TTL', '15m');
  vi.stubEnv('JWT_REFRESH_TTL_DAYS', '7');
  authenticate = (await import('../src/shared/middlewares/authenticate.js')).authenticate;
});

describe('authenticate', () => {
  it('rejects missing tokens', () => {
    const { req, res, next } = middlewareArgs();

    authenticate(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, code: 'UNAUTHORIZED' }));
  });

  it('rejects invalid tokens', () => {
    const { req, res, next } = middlewareArgs('Bearer not-a-token');

    authenticate(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, code: 'UNAUTHORIZED' }));
  });

  it('rejects expired tokens', () => {
    const token = jwt.sign({ role: Role.EDITOR }, 'test-secret-with-at-least-32-characters', {
      subject: 'user-1',
      expiresIn: '-1s',
      algorithm: 'HS256',
    });
    const { req, res, next } = middlewareArgs(`Bearer ${token}`);

    authenticate(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401, code: 'UNAUTHORIZED' }));
  });
});

describe('requireRole', () => {
  it('allows permitted roles', () => {
    const { req, res, next } = middlewareArgs();
    req.user = { id: 'user-1', role: Role.ADMIN };

    requireRole(Role.ADMIN)(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('rejects forbidden roles', () => {
    const { req, res, next } = middlewareArgs();
    req.user = { id: 'user-1', role: Role.EDITOR };

    requireRole(Role.ADMIN)(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403, code: 'FORBIDDEN' }));
  });
});

function middlewareArgs(authorization?: string): { req: Request; res: Response; next: NextFunction } {
  const req = {
    get: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
  } as Request;
  const res = {} as Response;
  const next = vi.fn((err?: AppError) => err) as unknown as NextFunction;

  return { req, res, next };
}
