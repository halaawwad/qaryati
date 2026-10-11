import type { Role } from '@prisma/client';
import type { RequestHandler } from 'express';
import { authService } from '../../modules/auth/auth.service.js';
import { UnauthorizedError } from '../errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user: {
        id: string;
        role: Role;
      };
    }
  }
}

export const authenticate: RequestHandler = (req, _res, next) => {
  try {
    const header = req.get('Authorization');
    const [scheme, token] = header?.split(' ') ?? [];

    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedError();
    }

    req.user = authService.verifyAccessToken(token);
    next();
  } catch (err) {
    next(err instanceof UnauthorizedError ? err : new UnauthorizedError());
  }
};
