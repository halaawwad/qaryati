import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RedisGeoLimiter as Limiter } from '../../src/integrations/geo/geo.limiter.js';

let db: PrismaClient, redis: Redis, app: Express, LimiterClass: typeof Limiter;
let keys: string[];
let actorId: string, governorateId: string;
const fetcher = vi.fn<typeof fetch>();
const providerRow = { lat: '31.1234567', lon: '35.7654321', display_name: 'Synthetic integration fixture, not real geographic data',
  osm_type: 'node', osm_id: 123, name: 'Fixture', address: { country_code: 'ps', state: 'Fixture Governorate' } };
const liveProviders: { circuit: { shutdown(): void } }[] = [];

beforeAll(async () => {
  const dbUrl = new URL(process.env.DATABASE_URL ?? ''); const cacheUrl = new URL(process.env.REDIS_URL ?? '');
  if (process.env.QARYATI_GEO_DISPOSABLE !== '1' || dbUrl.hostname !== '127.0.0.1' ||
    dbUrl.pathname !== '/qaryati_geo_disposable' || dbUrl.username !== 'geo_test' || cacheUrl.hostname !== '127.0.0.1') {
    throw new Error('Run scripts/test-geo-integration.mjs; only its disposable services are allowed');
  }
  vi.doMock('../../src/integrations/geo/geo.transport.js', () => ({ secureGeoFetch: fetcher }));
  ({ prisma: db } = await import('../../src/shared/db.js'));
  ({ redis } = await import('../../src/shared/cache.js'));
  if (redis.status !== 'ready') await new Promise<void>((resolve, reject) => { redis.once('ready', resolve); redis.once('error', reject); });
  const module = await import('../../src/integrations/geo/geo.limiter.js'); LimiterClass = module.RedisGeoLimiter; keys = module.GEO_LIMIT_KEYS;
  await redis.set(keys[0]!, '1');
  app = (await import('../../src/app.js')).createApp();
  actorId = (await db.user.create({ data: { email: 'geo-test@example.invalid', fullName: 'Geo fixture', passwordHash: 'unused', role: 'ADMIN' } })).id;
  governorateId = (await db.governorate.create({ data: { nameAr: 'Fixture', nameEn: 'Fixture', code: 'GEO_TEST' } })).id;
  await db.$executeRawUnsafe("CREATE FUNCTION geo_test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id = 'geo-audit-failure' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$");
  await db.$executeRawUnsafe('CREATE TRIGGER geo_test_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION geo_test_fail_audit()');
});
beforeEach(async () => {
  fetcher.mockReset().mockImplementation(async () => Response.json([providerRow]));
  // Exact coordination keys, on the runner-owned Redis only; previous test has finished.
  await redis.del(keys[1]!, keys[2]!); await redis.set(keys[0]!, '1');
});
afterAll(async () => {
  for (const provider of liveProviders) provider.circuit.shutdown();
  const { getGeoIntegration } = await import('../../src/integrations/geo/index.js');
  getGeoIntegration().provider.circuit.shutdown();
  redis?.disconnect(); await db?.$disconnect();
});

async function village(patch = {}) {
  const name = 'Fixture ' + randomUUID();
  return db.village.create({ data: { nameAr: name, nameEn: name, slug: randomUUID(), governorateId,
    historicalOverview: 'Preserve this field', verificationStatus: 'VERIFIED', ...patch } });
}
const auth = () => 'Bearer ' + jwt.sign({ role: 'ADMIN' }, process.env.JWT_ACCESS_SECRET!, { subject: actorId, expiresIn: '15m' });
const lookup = (id: string) => request(app).get('/api/v1/villages/' + id + '/geo-candidates').set('Authorization', auth());
const apply = (id: string, candidateRef: string, version = 1, overwriteExisting = false, requestId = randomUUID()) =>
  request(app).post('/api/v1/villages/' + id + '/geo-enrichment').set('Authorization', auth()).set('X-Request-Id', requestId)
    .send({ candidateRef, version, confirm: true, overwriteExisting });
async function selection(id: string) {
  const response = await lookup(id); expect(response.status).toBe(200);
  return response.body.data.candidates[0].candidateRef as string;
}

describe('geo with real disposable PostgreSQL and Redis; upstream HTTP mocked', () => {
  it('persists rounded coordinates, timestamps, actor, version and atomic audit without changing unrelated fields', async () => {
    const v = await village(); const ref = await selection(v.id);
    const response = await apply(v.id, ref, 1, false, 'geo-success'); expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ latitude: 31.123457, longitude: 35.765432, version: 2, verificationStatus: 'PENDING', geoDisplayName: providerRow.display_name });
    const stored = await db.village.findUniqueOrThrow({ where: { id: v.id } });
    expect(stored.latitude!.toNumber()).toBe(response.body.data.latitude);
    expect(stored.geoEnrichedAt!.toISOString()).toBe(response.body.data.geoEnrichedAt);
    expect(stored.updatedById).toBe(actorId); expect(stored.historicalOverview).toBe(v.historicalOverview);
    expect(stored.nameAr).toBe(v.nameAr); expect(stored.createdAt).toEqual(v.createdAt);
    const audit = await db.auditLog.findFirstOrThrow({ where: { entityId: v.id } });
    expect(await db.auditLog.count({ where: { entityId: v.id, requestId: 'geo-success' } })).toBe(1);
    expect(audit).toMatchObject({ actorId, requestId: 'geo-success', entityType: 'village', action: 'UPDATE' });
    expect(audit.before).toMatchObject({ latitude: null, version: 1 });
    expect(audit.after).toMatchObject({ latitude: String(response.body.data.latitude), version: 2, verificationStatus: 'PENDING', source: 'geo-enrichment', provenance: { provider: 'nominatim', candidateRef: ref } });
    expect((await request(app).get('/api/v1/villages/' + v.id)).body.data.latitude).toBe(response.body.data.latitude);
  });
  it('actual audit failure rolls back every village change', async () => {
    const v = await village(); const ref = await selection(v.id);
    const response = await apply(v.id, ref, 1, false, 'geo-audit-failure'); expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('synthetic audit failure');
    expect(await db.village.findUnique({ where: { id: v.id } })).toEqual(v);
    expect(await db.auditLog.count({ where: { entityId: v.id } })).toBe(0);
  });
  it('concurrent applications serialize and exactly one succeeds', async () => {
    const v = await village(); const ref = await selection(v.id);
    const results = await Promise.all([apply(v.id, ref), apply(v.id, ref)]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(await db.auditLog.count({ where: { entityId: v.id } })).toBe(1);
  });
  it('rejects missing, soft-deleted, expired, foreign and invalid references without updates', async () => {
    const v = await village(); const other = await village(); const ref = await selection(v.id);
    expect((await apply(other.id, ref)).status).toBe(400);
    expect((await apply(v.id, randomUUID())).status).toBe(400);
    await redis.pexpire('qaryati:geo:v1:candidate:' + ref, 1); await new Promise(resolve => setTimeout(resolve, 5));
    expect((await apply(v.id, ref)).status).toBe(400);
    await db.village.update({ where: { id: v.id }, data: { deletedAt: new Date() } });
    expect((await lookup(v.id)).status).toBe(404); expect((await apply(v.id, ref)).status).toBe(404);
    expect((await lookup(randomUUID())).status).toBe(404);
    expect(await db.auditLog.count({ where: { entityId: { in: [v.id, other.id] } } })).toBe(0);
  });
  it('requires deliberate overwrite and rejects later replay', async () => {
    const v = await village({ latitude: 0, longitude: 0 }); const ref = await selection(v.id);
    expect((await apply(v.id, ref)).status).toBe(409);
    expect((await apply(v.id, ref, 1, true)).status).toBe(200);
    expect((await apply(v.id, ref, 2, true)).status).toBe(409);
  });
  it('cached lookup avoids upstream calls and candidates receive short TTLs', async () => {
    const v = await village(); await selection(v.id); const ref = await selection(v.id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const ttl = await redis.ttl('qaryati:geo:v1:candidate:' + ref); expect(ttl).toBeGreaterThan(890); expect(ttl).toBeLessThanOrEqual(900);
    const cacheKeys = await redis.keys('qaryati:geo:v1:lookup:*');
    expect(cacheKeys.length).toBeGreaterThan(0); expect(await redis.ttl(cacheKeys[0]!)).toBeGreaterThan(2591900);
  });
  it('negatively caches no-match responses', async () => {
    fetcher.mockImplementation(async () => Response.json([])); const v = await village();
    expect((await lookup(v.id)).body.data.status).toBe('no_match');
    // Fixture has identical Arabic/English names and governorates: two unique queries.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await lookup(v.id)).body.data.status).toBe('no_match'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('shared limiter serializes independent clients with at least one second after completion', async () => {
    const { Redis } = await import('ioredis'); const second = new Redis(process.env.REDIS_URL!);
    await new Promise<void>(resolve => second.once('ready', resolve));
    try {
      const first = new LimiterClass(redis); const other = new LimiterClass(second);
      const starts: number[] = [];
      await Promise.all([first, other, first].map(async limiter => {
        const permit = await limiter.acquire(); starts.push(Date.now());
        await new Promise(resolve => setTimeout(resolve, 30)); await permit.release();
      }));
      expect(starts).toHaveLength(3);
      for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(1000);
    } finally { second.disconnect(); }
  }, 10000);
  it('coordination fails closed without activation and while a crashed worker retains the lock', async () => {
    await redis.del(keys[0]!);
    await expect(new LimiterClass(redis).acquire()).rejects.toMatchObject({ code: 'GEO_DISABLED' });
    await redis.set(keys[0]!, '1'); await new LimiterClass(redis).acquire();
    expect(await redis.pttl(keys[1]!)).toBe(-1);
    await expect(new LimiterClass(redis, 100).acquire()).rejects.toMatchObject({ code: 'GEO_BUSY' });
  });
  it('429 cooldown is stored centrally and blocks another replica', async () => {
    fetcher.mockImplementation(async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
    const v = await village(); expect((await lookup(v.id)).status).toBe(503);
    expect(await redis.pttl(keys[2]!)).toBeGreaterThan(119000);
    await expect(new LimiterClass(redis, 100).acquire()).rejects.toMatchObject({ code: 'GEO_BUSY' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('Redis outage fails closed without upstream calls', async () => {
    const { Redis } = await import('ioredis');
    const { RedisGeoStore } = await import('../../src/integrations/geo/geo.store.js');
    const client = new Redis(process.env.REDIS_URL!, { lazyConnect: true }); client.disconnect();
    await expect(new RedisGeoStore(client).get('key')).rejects.toMatchObject({ code: 'GEO_CACHE_UNAVAILABLE' });
    await expect(new LimiterClass(client).acquire()).rejects.toMatchObject({ code: 'GEO_COORDINATION_UNAVAILABLE' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('existing nearby-village Haversine read still works after enrichment', async () => {
    const first = await village(); const ref = await selection(first.id); expect((await apply(first.id, ref)).status).toBe(200);
    const second = await village({ latitude: 31.123457, longitude: 35.765432 });
    const response = await request(app).get('/api/v1/villages/' + first.id + '/nearby').query({ radiusKm: 1 });
    expect(response.status).toBe(200); expect(response.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: second.id, distanceKm: 0 })]));
  });
});
