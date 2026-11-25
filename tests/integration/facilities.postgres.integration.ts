import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { Express } from 'express';
import type { PrismaClient, Role } from '@prisma/client';
import type { Redis } from 'ioredis';
import { validateFacilitiesTarget } from '../../scripts/facilities-integration-safety.mjs';

let db: PrismaClient;
let appDb: PrismaClient;
let cache: Redis;
let app: Express;
let villageId: string;
let sourceId: string;
let governorateId: string;
const actors = {} as Record<Role | 'OTHER_EDITOR', { id: string; token: string }>;

beforeAll(async () => {
  const { token, name } = validateFacilitiesTarget(process.env);
  const { PrismaClient } = await import('@prisma/client');
  db = new PrismaClient({ log: [] });
  expect(await db.$queryRaw`SELECT current_database() AS database, current_user AS username`)
    .toEqual([{ database: name, username: name }]);
  expect(await db.$queryRaw`SELECT shobj_description(oid, 'pg_database') AS token FROM pg_database WHERE datname = current_database()`)
    .toEqual([{ token }]);
  const { Redis } = await import('ioredis');
  cache = new Redis(process.env.REDIS_URL!, { lazyConnect: true, retryStrategy: () => null });
  await cache.connect();
  expect(await cache.get('facilities-integration-guard')).toBe(token);
  // Only verified disposable databases may receive fixtures or failure-injection DDL.
  await db.$executeRawUnsafe(`CREATE FUNCTION facilities_reject_test_audit() RETURNS trigger AS $$
    BEGIN
      IF NEW.request_id LIKE 'facilities-audit-fail-%' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql`);
  await db.$executeRawUnsafe(`CREATE TRIGGER facilities_test_audit_failure BEFORE INSERT ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION facilities_reject_test_audit()`);
  for (const key of ['EDITOR', 'OTHER_EDITOR', 'REVIEWER', 'ADMIN'] as const) {
    const role = key === 'OTHER_EDITOR' ? 'EDITOR' : key;
    const user = await db.user.create({ data: { email: `${randomUUID()}@facilities.invalid`,
      fullName: 'Synthetic actor', passwordHash: 'unused', role } });
    actors[key] = { id: user.id, token: jwt.sign({ role }, process.env.JWT_ACCESS_SECRET!, { subject: user.id, expiresIn: '10m' }) };
  }
  const governorate = await db.governorate.create({ data: {
    code: randomUUID(), nameAr: `Synthetic ${randomUUID()}`, nameEn: `Synthetic ${randomUUID()}`,
  } });
  governorateId = governorate.id;
  app = (await import('../../src/app.js')).createApp();
  appDb = (await import('../../src/shared/db.js')).prisma;
}, 30000);

beforeEach(async () => {
  villageId = (await db.village.create({ data: { slug: `facilities-${randomUUID()}`, nameAr: 'Synthetic village', governorateId } })).id;
  sourceId = (await db.source.create({ data: { title: 'Synthetic source', sourceType: 'BOOK' } })).id;
});
afterAll(async () => {
  if (appDb) await appDb.$disconnect();
  if (app) (await import('../../src/shared/cache.js')).redis.disconnect();
  cache?.disconnect();
  if (db) await db.$disconnect();
});

function call(method: 'post' | 'patch' | 'delete', id?: string, actor: keyof typeof actors = 'EDITOR') {
  return request(app)[method](method === 'post' ? `/api/v1/villages/${villageId}/facilities` : `/api/v1/facilities/${id}`)
    .set('Authorization', `Bearer ${actors[actor].token}`);
}
const body = () => ({ name: 'Synthetic school', facilityType: 'SCHOOL', sourceId,
  description: 'Original', asOfYear: 2020, latitude: 31.123456, longitude: 35.123456 });
async function create(actor: keyof typeof actors = 'EDITOR') {
  const response = await call('post', undefined, actor).send(body());
  expect(response.status).toBe(201);
  return response.body.data as { id: string; version: number };
}
const row = (id: string) => db.facility.findUniqueOrThrow({ where: { id } });
const audits = (id: string) => db.auditLog.findMany({ where: { entityType: 'Facility', entityId: id }, orderBy: { createdAt: 'asc' } });

describe('Facilities real HTTP, PostgreSQL and Redis', () => {
  it.each(['EDITOR', 'REVIEWER', 'ADMIN'] as const)('POST by %s creates PENDING/version 1 and one audit; GET/list remain public', async actor => {
    const item = await create(actor);
    expect(await row(item.id)).toMatchObject({ version: 1, verificationStatus: 'PENDING', createdById: actors[actor].id });
    const detail = await request(app).get(`/api/v1/facilities/${item.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ ...body(), version: 1 });
    expect(detail.body.data).not.toHaveProperty('createdById');
    expect(detail.body.data).not.toHaveProperty('deletedAt');
    expect((await request(app).get(`/api/v1/villages/${villageId}/facilities`)).body.data).toHaveLength(1);
    expect(await audits(item.id)).toEqual([expect.objectContaining({ action: 'CREATE', actorId: actors[actor].id,
      before: null, after: expect.objectContaining({ ...body(), version: 1 }) })]);
    expect((await cache.keys('rl:global:*')).length).toBeGreaterThan(0);
  });

  it.each(['EDITOR', 'REVIEWER', 'ADMIN'] as const)('PATCH by %s preserves omissions, resets status and audits once', async actor => {
    const item = await create();
    if (actor !== 'EDITOR') await db.facility.update({ where: { id: item.id }, data: { verificationStatus: 'VERIFIED' } });
    const response = await call('patch', item.id, actor).send({ version: 1, name: 'Renamed' });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ ...body(), name: 'Renamed', version: 2, verificationStatus: 'PENDING' });
    expect(await row(item.id)).toMatchObject({ version: 2, updatedById: actors[actor].id });
    const entries = await audits(item.id);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ action: 'UPDATE', actorId: actors[actor].id,
      before: { name: body().name, version: 1 }, after: { name: 'Renamed', version: 2, verificationStatus: 'PENDING' } });
    const before = await row(item.id);
    const stale = await call('patch', item.id, actor).send({ version: 1, name: 'Stale' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(await row(item.id)).toEqual(before);
    expect(await audits(item.id)).toHaveLength(2);
  });

  it('rejects other/no-creator edits and reviewed records for EDITOR', async () => {
    const item = await create();
    expect((await call('patch', item.id, 'OTHER_EDITOR').send({ version: 1, name: 'X' })).body.error.code).toBe('FACILITY_EDIT_FORBIDDEN');
    await db.facility.update({ where: { id: item.id }, data: { createdById: null } });
    expect((await call('patch', item.id).send({ version: 1, name: 'X' })).status).toBe(403);
    for (const status of ['VERIFIED', 'REJECTED'] as const) {
      await db.facility.update({ where: { id: item.id }, data: { createdById: actors.EDITOR.id, verificationStatus: status } });
      const response = await call('patch', item.id).send({ version: 1, name: 'X' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('CHANGE_REQUEST_REQUIRED');
    }
    expect(await audits(item.id)).toHaveLength(1);
  });

  it.each(['post', 'patch', 'delete'] as const)('%s requires a valid supported-role bearer token', async method => {
    const item = await create();
    const url = method === 'post' ? `/api/v1/villages/${villageId}/facilities` : `/api/v1/facilities/${item.id}`;
    const unsupported = jwt.sign({ role: 'VIEWER' }, process.env.JWT_ACCESS_SECRET!, { subject: actors.EDITOR.id });
    const expired = jwt.sign({ role: 'ADMIN' }, process.env.JWT_ACCESS_SECRET!, { subject: actors.ADMIN.id, expiresIn: -1 });
    for (const auth of ['', 'Bearer invalid', `Bearer ${unsupported}`, `Bearer ${expired}`]) {
      const req = request(app)[method](url);
      if (auth) req.set('Authorization', auth);
      expect((await req.send({ version: 1, name: 'X' })).status).toBe(401);
    }
    expect(await audits(item.id)).toHaveLength(1);
  });

  it.each(['verificationStatus', 'createdById', 'updatedById', 'deletedAt'])('rejects protected %s through HTTP', async field => {
    const item = await create();
    expect((await call('patch', item.id).send({ version: 1, name: 'X', [field]: 'protected' })).status).toBe(400);
    expect(await row(item.id)).toMatchObject({ version: 1, name: body().name });
    expect(await audits(item.id)).toHaveLength(1);
  });

  it('enforces coordinate pairs, stores boundaries and rounded values, and clears nullable fields together', async () => {
    const item = await create();
    for (const invalid of [{ latitude: 0 }, { longitude: null }, { latitude: 0, longitude: null },
      { latitude: 91, longitude: 0 }, { latitude: 0, longitude: -181 }, {}, { version: 0, name: 'X' }]) {
      expect((await call('patch', item.id).send({ version: 1, ...invalid })).status).toBe(400);
    }
    let version = 1;
    for (const coords of [{ latitude: -90, longitude: -180 }, { latitude: 90, longitude: 180 },
      { latitude: 0, longitude: 0 }, { latitude: 31.1234567, longitude: 35.7654321 }]) {
      const response = await call('patch', item.id).send({ version, ...coords });
      expect(response.status).toBe(200);
      version++;
      expect(response.body.data).toMatchObject({ version, latitude: Number(coords.latitude.toFixed(6)), longitude: Number(coords.longitude.toFixed(6)) });
      const entries = await audits(item.id);
      expect(entries.at(-1)?.after).toMatchObject({ latitude: response.body.data.latitude, longitude: response.body.data.longitude });
    }
    const cleared = await call('patch', item.id).send({ version, latitude: null, longitude: null, description: null, asOfYear: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ latitude: null, longitude: null, description: null, asOfYear: null, version: version + 1 });
  });

  it('checks changed sources, allows unchanged deleted source, and filters deleted parents', async () => {
    const item = await create();
    const deleted = await db.source.create({ data: { title: 'Deleted source', sourceType: 'BOOK', deletedAt: new Date() } });
    for (const invalid of [randomUUID(), deleted.id]) {
      expect((await call('patch', item.id).send({ version: 1, sourceId: invalid })).status).toBe(404);
    }
    await db.source.update({ where: { id: sourceId }, data: { deletedAt: new Date() } });
    expect((await call('patch', item.id).send({ version: 1, sourceId, name: 'Unrelated' })).status).toBe(200);
    const valid = await db.source.create({ data: { title: 'Valid replacement', sourceType: 'BOOK' } });
    expect((await call('patch', item.id).send({ version: 2, sourceId: valid.id })).status).toBe(200);
    expect(await row(item.id)).toMatchObject({ sourceId: valid.id, version: 3 });
    await db.village.update({ where: { id: villageId }, data: { deletedAt: new Date() } });
    expect((await request(app).get(`/api/v1/facilities/${item.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/villages/${villageId}/facilities`)).status).toBe(404);
    expect((await call('patch', item.id).send({ version: 3, name: 'X' })).status).toBe(404);
    expect((await call('delete', item.id, 'ADMIN')).status).toBe(404);
  });

  it.each(['post', 'patch', 'delete'] as const)('rolls back %s on real database audit failure', async method => {
    const item = method === 'post' ? undefined : await create();
    const before = item ? await row(item.id) : undefined;
    const count = await db.facility.count({ where: { villageId } });
    const requestId = `facilities-audit-fail-${randomUUID()}`;
    const req = call(method, item?.id, 'ADMIN').set('X-Request-Id', requestId);
    const response = await (method === 'delete' ? req : req.send(method === 'post' ? body() : { version: 1, name: 'Rollback' }));
    expect(response.status).toBe(500);
    expect(await db.facility.count({ where: { villageId } })).toBe(count);
    expect(await db.auditLog.count({ where: { requestId } })).toBe(0);
    if (item) { expect(await row(item.id)).toEqual(before); expect(await audits(item.id)).toHaveLength(1); }
  });

  it('allows one successful concurrent versioned update and one 409', async () => {
    const item = await create();
    const results = await Promise.all(['First', 'Second'].map(name => call('patch', item.id, 'ADMIN').send({ version: 1, name })));
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(results.find(result => result.status === 409)?.body.error.code).toBe('VERSION_CONFLICT');
    const winner = results.find(result => result.status === 200)!.body.data;
    expect(await row(item.id)).toMatchObject({ version: 2, name: winner.name });
    expect(await audits(item.id)).toHaveLength(2);
  });

  it.each(['EDITOR', 'REVIEWER'] as const)('forbids DELETE by %s', async actor => {
    const item = await create();
    expect((await call('delete', item.id, actor)).status).toBe(403);
    expect(await row(item.id)).toMatchObject({ deletedAt: null, version: 1 });
    expect(await audits(item.id)).toHaveLength(1);
  });

  it('soft deletes once, preserves physical row/version, excludes public reads and audits correct values', async () => {
    const item = await create();
    const response = await call('delete', item.id, 'ADMIN');
    expect(response.status).toBe(204); expect(response.text).toBe('');
    const stored = await row(item.id);
    expect(stored).toMatchObject({ deletedAt: expect.any(Date), updatedById: actors.ADMIN.id, version: 1 });
    expect((await request(app).get(`/api/v1/facilities/${item.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/villages/${villageId}/facilities`)).body.data).toEqual([]);
    expect((await call('delete', item.id, 'ADMIN')).status).toBe(404);
    const entries = await audits(item.id);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ action: 'DELETE', actorId: actors.ADMIN.id,
      before: { ...body(), version: 1, deletedAt: null },
      after: { ...body(), version: 1, deletedAt: stored.deletedAt!.toISOString() } });
  });

  it('handles concurrent edit/delete with an accurate deletion snapshot', async () => {
    const item = await create();
    const [edit, deletion] = await Promise.all([
      call('patch', item.id, 'ADMIN').send({ version: 1, name: 'Concurrent edit' }), call('delete', item.id, 'ADMIN'),
    ]);
    expect(deletion.status).toBe(204);
    expect([200, 404]).toContain(edit.status);
    const stored = await row(item.id);
    const version = edit.status === 200 ? 2 : 1;
    expect(stored).toMatchObject({ version, deletedAt: expect.any(Date) });
    const entries = await audits(item.id);
    expect(entries).toHaveLength(edit.status === 200 ? 3 : 2);
    expect(entries.find(entry => entry.action === 'DELETE')?.before).toMatchObject({ version, name: stored.name });
  });

  it('permits only one concurrent deletion and one DELETE audit', async () => {
    const item = await create();
    const results = await Promise.all([call('delete', item.id, 'ADMIN'), call('delete', item.id, 'ADMIN')]);
    expect(results.map(result => result.status).sort()).toEqual([204, 404]);
    expect(await audits(item.id)).toHaveLength(2);
  });
});
