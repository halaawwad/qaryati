import { z } from 'zod';
import { geoEnvShape, validGeoUserAgent } from '../integrations/geo/geo.config.js';

const booleanEnv = z.enum(['true', 'false']).transform((value) => value === 'true');
// Keep window durations within Node's timer range (also used by the test memory store).
const windowMinutesEnv = z.coerce.number().int().positive().max(35791);
const rateLimitMaxEnv = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const envSchema = z.object({
  ...geoEnvShape,
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .regex(/^postgres(ql)?:\/\/.+/, 'must be a postgresql:// connection URL'),
  REDIS_URL: z
    .string({ error: 'REDIS_URL is required' })
    .regex(/^rediss?:\/\/.+/, 'must be a redis:// or rediss:// URL'),
  JWT_ACCESS_SECRET: z.string({ error: 'JWT_ACCESS_SECRET is required' }).min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  TRUST_PROXY: booleanEnv.default(false),
  RATE_LIMIT_ENABLED: booleanEnv.default(true),
  RATE_LIMIT_WINDOW_MINUTES: windowMinutesEnv.default(15),
  RATE_LIMIT_MAX: rateLimitMaxEnv.default(300),
  LOGIN_RATE_LIMIT_WINDOW_MINUTES: windowMinutesEnv.default(15),
  LOGIN_RATE_LIMIT_MAX: rateLimitMaxEnv.default(5),
  REGISTER_RATE_LIMIT_WINDOW_MINUTES: windowMinutesEnv.default(60),
  REGISTER_RATE_LIMIT_MAX: rateLimitMaxEnv.default(10),
  REFRESH_RATE_LIMIT_WINDOW_MINUTES: windowMinutesEnv.default(15),
  REFRESH_RATE_LIMIT_MAX: rateLimitMaxEnv.default(30),
  // Comma-separated list of allowed origins, or "*" to allow any origin.
  CORS_ORIGINS: z
    .string()
    .default('*')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
}).refine(value => !value.GEO_ENABLED || validGeoUserAgent(value.GEO_USER_AGENT), {
  path: ['GEO_USER_AGENT'], message: 'Enabled geo lookup requires an application/version User-Agent with real contact URL or email',
});

export type Env = z.infer<typeof envSchema>;

/** The placeholder in .env.example. It is long enough to pass the length check, but it is public. */
export const EXAMPLE_JWT_ACCESS_SECRET = 'replace_with_at_least_32_characters_secret';

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    console.error(`Invalid environment configuration:\n${problems}`);
    process.exit(1);
  }

  if (result.data.JWT_ACCESS_SECRET === EXAMPLE_JWT_ACCESS_SECRET) {
    const message =
      'JWT_ACCESS_SECRET still has the .env.example placeholder, so anyone can sign tokens. Generate one with: ' +
      `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`;

    if (result.data.NODE_ENV === 'production') {
      console.error(`Invalid environment configuration:\n  - JWT_ACCESS_SECRET: ${message}`);
      process.exit(1);
    }

    // Local setups keep working, but are told to replace it.
    console.warn(`Warning: ${message}`);
  }

  return result.data;
}

export const env = loadEnv();

export const isDevelopment = env.NODE_ENV === 'development';
export const isProduction = env.NODE_ENV === 'production';
