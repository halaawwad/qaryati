import { createHash, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { geoCandidateSchema, normalizeGeoText, type GeoLookup } from './geo.provider.js';
import { GeoError } from './geo.errors.js';

export interface GeoStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
}

// Bound geo-specific Redis waits without changing the shared client's behavior.
// A timed-out command may still finish; callers fail closed and never use a late
// permit. Such a late acquisition can leave a stale lock for operator recovery.
export async function geoRedisCommand<T>(command: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      command(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Geo Redis timeout')), 2000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export class RedisGeoStore implements GeoStore {
  constructor(private readonly client: Redis) {}
  async get(key: string) {
    try {
      if (this.client.status !== 'ready') throw new Error();
      return await geoRedisCommand(() => this.client.get(key));
    } catch { throw new GeoError('GEO_CACHE_UNAVAILABLE', 'Geographic lookup storage is unavailable'); }
  }
  async put(key: string, value: string, ttlSeconds: number) {
    try {
      if (this.client.status !== 'ready') throw new Error();
      await geoRedisCommand(() => this.client.set(key, value, 'EX', ttlSeconds));
    } catch { throw new GeoError('GEO_CACHE_UNAVAILABLE', 'Geographic lookup storage is unavailable'); }
  }
}

export function geoIdentity(input: GeoLookup): string {
  return createHash('sha256').update(JSON.stringify([
    input.nameAr, input.nameEn ?? '', input.governorate.nameAr, input.governorate.nameEn, input.countryCode,
  ].map(normalizeGeoText))).digest('hex');
}

export const candidateRecordSchema = z.object({
  villageId: z.uuid(), version: z.number().int().positive(), identity: z.string(),
  expiresAt: z.number(), candidate: geoCandidateSchema,
});
export type CandidateRecord = z.infer<typeof candidateRecordSchema>;

export class GeoCandidateStore {
  constructor(private readonly store: GeoStore, private readonly ttlSeconds: number) {}
  async issue(record: Omit<CandidateRecord, 'expiresAt'>) {
    const candidateRef = randomUUID();
    const expiresAt = Date.now() + this.ttlSeconds * 1000;
    await this.store.put('qaryati:geo:v1:candidate:' + candidateRef, JSON.stringify({ ...record, expiresAt }), this.ttlSeconds);
    return { candidateRef, expiresAt: new Date(expiresAt).toISOString(), ...record.candidate };
  }
  async read(reference: string): Promise<CandidateRecord | null> {
    const raw = await this.store.get('qaryati:geo:v1:candidate:' + reference);
    if (!raw) return null;
    try {
      const record = candidateRecordSchema.parse(JSON.parse(raw));
      return record.expiresAt > Date.now() ? record : null;
    } catch { return null; }
  }
}
