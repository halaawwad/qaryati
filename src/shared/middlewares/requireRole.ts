import type { Role } from '@prisma/client';
import type { RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '../errors.js';

export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      next(new UnauthorizedError());
      return;
    }

    if (!roles.includes(req.user.role)) {
      next(new ForbiddenError());
      return;
    }

    next();
  };
}
