import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { GeoError } from './geo.errors.js';
import { geoRedisCommand } from './geo.store.js';

export interface GeoPermit { release(cooldownMs?: number): Promise<void> }
export interface GeoLimiter { acquire(): Promise<GeoPermit> }
export const GEO_LIMIT_KEYS = ['qaryati:geo:{nominatim}:enabled', 'qaryati:geo:{nominatim}:lock', 'qaryati:geo:{nominatim}:cooldown'];
export const ACQUIRE_GEO = `
if redis.call('GET', KEYS[1]) ~= '1' then return -1 end
if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
if redis.call('SET', KEYS[2], ARGV[1], 'NX') then return 1 end
return 0`;
export const RELEASE_GEO = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], '1', 'PX', ARGV[2])
redis.call('DEL', KEYS[1])
return 1`;

// The lock deliberately has NO lease expiry. A stalled/crashed worker cannot be
// overtaken by another replica. Recovery requires stopping workers (see runbook).
export class RedisGeoLimiter implements GeoLimiter {
  constructor(private readonly client: Redis, private readonly waitMs = 5000) {}
  async acquire(): Promise<GeoPermit> {
    const token = randomUUID();
    const deadline = Date.now() + this.waitMs;
    try {
      do {
        if (this.client.status !== 'ready') throw new Error();
        const result = await geoRedisCommand(() => this.client.eval(ACQUIRE_GEO, 3, ...GEO_LIMIT_KEYS, token));
        if (result === -1) throw new GeoError('GEO_DISABLED', 'Geographic provider coordination requires operator activation');
        if (result === 1) return { release: async (cooldownMs = 1000) => {
          try {
            if (this.client.status !== 'ready') throw new Error();
            const released = await geoRedisCommand(() => this.client.eval(RELEASE_GEO, 2, GEO_LIMIT_KEYS[1]!, GEO_LIMIT_KEYS[2]!, token, Math.max(1000, cooldownMs)));
            if (released !== 1) throw new Error();
          } catch { throw new GeoError('GEO_COORDINATION_UNAVAILABLE', 'Geographic provider coordination is unavailable'); }
        } };
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      throw new GeoError('GEO_BUSY', 'Geographic provider is busy; try again later');
    } catch (error) {
      if (error instanceof GeoError) throw error;
      throw new GeoError('GEO_COORDINATION_UNAVAILABLE', 'Geographic provider coordination is unavailable');
    }
  }
}
