import { createHash } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, MemoryStore, rateLimit, type Store } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { env } from '../../config/env.js';
import { redis } from '../cache.js';
import { AppError } from '../errors.js';
import { logger } from '../logger.js';

type LimiterKind = 'global' | 'login' | 'register' | 'refresh';
const MINUTE_MS = 60 * 1000;

export function loginRateLimitKey(req: Request): string {
  const email: unknown = req.body?.email;
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const hash = createHash('sha256').update(normalized).digest('hex');
  return `${ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? '')}:${hash}`;
}

function warnStoreFailure(): void {
  // Store errors may include command arguments/keys. Never pass the error to the logger.
  logger.warn('Rate limit store unavailable; allowing requests without strict limits');
}

function protectDecrement(store: Store): Store {
  const decrement = store.decrement.bind(store);
  store.decrement = async (key) => {
    try {
      await decrement(key);
    } catch {
      // skipSuccessfulRequests decrements after the response; do not reject in a finish listener.
      warnStoreFailure();
    }
  };
  return store;
}

export function createRateLimiter(kind: LimiterKind, store?: Store): RequestHandler {
  if (!env.RATE_LIMIT_ENABLED) return (_req, _res, next) => next();

  const limits = {
    global: [env.RATE_LIMIT_WINDOW_MINUTES, env.RATE_LIMIT_MAX],
    login: [env.LOGIN_RATE_LIMIT_WINDOW_MINUTES, env.LOGIN_RATE_LIMIT_MAX],
    register: [env.REGISTER_RATE_LIMIT_WINDOW_MINUTES, env.REGISTER_RATE_LIMIT_MAX],
    refresh: [env.REFRESH_RATE_LIMIT_WINDOW_MINUTES, env.REFRESH_RATE_LIMIT_MAX],
  } as const;
  const [minutes, max] = limits[kind];
  const counterStore = store ?? (env.NODE_ENV === 'test' ? new MemoryStore() : new RedisStore({
    prefix: `rl:${kind}:`,
    sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply>,
  }));

  return rateLimit({
    windowMs: minutes * MINUTE_MS,
    max,
    store: protectDecrement(counterStore),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    passOnStoreError: true,
    logger: {
      error: warnStoreFailure,
      warn: () => logger.warn('Rate limit configuration warning'),
    },
    skip: (req) => kind === 'global' && req.method === 'GET' && /^\/health\/?$/i.test(req.path),
    skipSuccessfulRequests: kind === 'login',
    requestWasSuccessful: (_req, res) => res.statusCode >= 200 && res.statusCode < 300,
    ...(kind === 'login' ? { keyGenerator: loginRateLimitKey } : {}),
    handler: (_req, _res, next) => {
      next(new AppError(429, 'TOO_MANY_REQUESTS', 'Too many requests; please try again later'));
    },
  });
}
