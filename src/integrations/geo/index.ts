import { env } from '../../config/env.js';
import { redis } from '../../shared/cache.js';
import { GeoError } from './geo.errors.js';
import { RedisGeoLimiter } from './geo.limiter.js';
import { GeoCandidateStore, RedisGeoStore } from './geo.store.js';
import { NominatimProvider } from './nominatim.provider.js';

let integration: { provider: NominatimProvider; candidates: GeoCandidateStore } | undefined;
export function getGeoIntegration() {
  if (!env.GEO_ENABLED) throw new GeoError('GEO_DISABLED', 'Geographic lookup is disabled');
  if (!integration) {
    const store = new RedisGeoStore(redis);
    integration = {
      candidates: new GeoCandidateStore(store, env.GEO_CANDIDATE_TTL_SECONDS),
      provider: new NominatimProvider({
        endpoint: env.GEO_NOMINATIM_URL, userAgent: env.GEO_USER_AGENT, timeoutMs: env.GEO_TIMEOUT_MS,
        cacheTtlSeconds: env.GEO_CACHE_TTL_SECONDS, negativeTtlSeconds: env.GEO_NEGATIVE_TTL_SECONDS,
        circuitThresholdPercent: env.GEO_CIRCUIT_THRESHOLD_PERCENT, circuitResetMs: env.GEO_CIRCUIT_RESET_MS,
      }, new RedisGeoLimiter(redis), store),
    };
  }
  return integration;
}
