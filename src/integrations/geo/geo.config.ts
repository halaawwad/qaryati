import { z } from 'zod';
import { isIP } from 'node:net';

export function safeGeoEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      (!url.port || url.port === '443') && url.pathname === '/search' &&
      !isIP(url.hostname.replace(/^\[|\]$/g, '')) && url.hostname.includes('.') &&
      !url.hostname.endsWith('.localhost') && !url.hostname.endsWith('.local');
  } catch { return false; }
}

export const geoEnvShape = {
  GEO_ENABLED: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  GEO_NOMINATIM_URL: z.string().refine(safeGeoEndpoint, 'Must be an HTTPS /search endpoint on a public DNS hostname').default('https://nominatim.openstreetmap.org/search'),
  GEO_USER_AGENT: z.string().max(300).regex(/^[\x20-\x7e]*$/).default(''),
  GEO_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(5000),
  GEO_CACHE_TTL_SECONDS: z.coerce.number().int().min(60).max(31536000).default(2592000),
  GEO_NEGATIVE_TTL_SECONDS: z.coerce.number().int().min(1).max(86400).default(300),
  GEO_CANDIDATE_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  GEO_CIRCUIT_THRESHOLD_PERCENT: z.coerce.number().min(1).max(100).default(50),
  GEO_CIRCUIT_RESET_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
};

export function validGeoUserAgent(value: string): boolean {
  return /^[A-Za-z][\w.-]*\/[^\s]+ .*(https:\/\/[^\s)]+|[^\s()@]+@[^\s()@]+\.[^\s()@]+).*$/u.test(value) &&
    !/example\.|replace|change_me/i.test(value);
}
