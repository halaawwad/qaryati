import { pino } from 'pino';
import { env } from '../config/env.js';

const SENSITIVE_KEYS = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
] as const;

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'qaryati-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      ...SENSITIVE_KEYS,
      ...SENSITIVE_KEYS.map((key) => `*.${key}`),
      ...SENSITIVE_KEYS.map((key) => `*.*.${key}`),
    ],
    censor: '[REDACTED]',
  },
});
