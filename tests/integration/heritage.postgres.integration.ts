import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { Express } from 'express';
import type { PrismaClient, Role } from '@prisma/client';
import type { Redis } from 'ioredis';
import { validateHeritageTarget } from '../../scripts/heritage-integration-safety.mjs';

let db: PrismaClient;
let appDb: PrismaClient;
let cache: Redis;
let app: Express;
let villageId: string;
let sourceId: string;
let governorateId: string;
const actors = {} as Record<Role | 'OTHER_EDITOR', { id: string; token: string }>;
beforeAll(async () => {
  const { token, name } = validateHeritageTarget(process.env);
  const { PrismaClient } = await import('@prisma/client');
  db = new PrismaClient({ log: [] });
  expect(await db.$queryRaw`SELECT current_database() AS database, current_user AS username`).toEqual([{ database: name, username: name }]);
  expect(await db.$queryRaw`SELECT shobj_description(oid, 'pg_database') AS token FROM pg_database WHERE datname = current_database()`).toEqual([{ token }]);
  const { Redis } = await import('ioredis');
  cache = new Redis(process.env.REDIS_URL!, { lazyConnect: true, retryStrategy: () => null });
  await cache.connect(); expect(await cache.get('heritage-integration-guard')).toBe(token);
  // No fixture writes or application imports until both disposable identities are verified.
  await db.$executeRawUnsafe(`CREATE FUNCTION heritage_reject_test_audit() RETURNS trigger AS $$
    BEGIN
      IF NEW.request_id LIKE 'heritage-audit-fail-%' THEN RAISE EXCEPTION 'Synthetic audit failure'; END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql`);
  await db.$executeRawUnsafe(`CREATE TRIGGER heritage_test_audit_failure BEFORE INSERT ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION heritage_reject_test_audit()`);
  for (const key of ['EDITOR', 'OTHER_EDITOR', 'REVIEWER', 'ADMIN'] as const) {
    const role = key === 'OTHER_EDITOR' ? 'EDITOR' : key;
    const user = await db.user.create({ data: { email: `${randomUUID()}@heritage.invalid`, fullName: 'Synthetic actor', passwordHash: 'unused', role } });
    actors[key] = { id: user.id, token: jwt.sign({ role }, process.env.JWT_ACCESS_SECRET!, { subject: user.id, expiresIn: '10m' }) };
  }
  governorateId = (await db.governorate.create({ data: { code: randomUUID(), nameAr: `Synthetic ${randomUUID()}`, nameEn: `Synthetic ${randomUUID()}` } })).id;
  app = (await import('../../src/app.js')).createApp(); appDb = (await import('../../src/shared/db.js')).prisma;
}, 30000);
beforeEach(async () => {
  villageId = (await db.village.create({ data: { slug: `heritage-${randomUUID()}`, nameAr: 'Synthetic village', governorateId } })).id;
  sourceId = (await db.source.create({ data: { title: 'Synthetic source', sourceType: 'BOOK' } })).id;
});
afterAll(async () => {
  if (appDb) await appDb.$disconnect();
  if (app) (await import('../../src/shared/cache.js')).redis.disconnect();
  cache?.disconnect(); if (db) await db.$disconnect();
});
function call(method: 'post' | 'patch' | 'delete', id?: string, actor: keyof typeof actors = 'EDITOR') {
  return request(app)[method](method === 'post' ? `/api/v1/villages/${villageId}/heritage` : `/api/v1/heritage/${id}`)
    .set('Authorization', `Bearer ${actors[actor].token}`);
}
const body = () => ({ name: 'Synthetic heritage', category: 'CRAFT', description: 'Original', sourceId });
async function create(actor: keyof typeof actors = 'EDITOR') {
  const response = await call('post', undefined, actor).send(body()); expect(response.status).toBe(201);
  return response.body.data as { id: string; version: number };
}
const row = (id: string) => db.heritageItem.findUniqueOrThrow({ where: { id } });
const audits = (id: string) => db.auditLog.findMany({ where: { entityType: 'HeritageItem', entityId: id }, orderBy: { createdAt: 'asc' } });
describe('Heritage real HTTP, PostgreSQL and Redis', () => {
  it.each(['EDITOR', 'REVIEWER', 'ADMIN'] as const)('creates as %s, reads publicly and records one CREATE audit', async actor => {
    const item = await create(actor);
    expect(await row(item.id)).toMatchObject({ ...body(), version: 1, verificationStatus: 'PENDING', createdById: actors[actor].id, updatedById: actors[actor].id });
    const detail = await request(app).get(`/api/v1/heritage/${item.id}`); expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ ...body(), version: 1 }); expect(detail.body.data).not.toHaveProperty('createdById');
    expect(detail.body.data).not.toHaveProperty('deletedAt');
    const list = await request(app).get(`/api/v1/villages/${villageId}/heritage`).query({ category: 'CRAFT', search: 'Synthetic', limit: 1 });
    expect(list.status).toBe(200); expect(list.body.data).toHaveLength(1);
    expect(await audits(item.id)).toEqual([expect.objectContaining({ action: 'CREATE', actorId: actors[actor].id,
      before: null, after: expect.objectContaining({ ...body(), version: 1 }) })]);
    expect((await cache.keys('rl:global:*')).length).toBeGreaterThan(0);
  });
  it.each(['CRAFT','FOOD','AGRI_PRACTICE','CUSTOM','OTHER'])('accepts category %s without a source and allows duplicate names', async category => {
    for (const optional of [{}, { sourceId: null, description: null }]) {
      const response = await call('post').send({ name: 'Item', category, ...optional }); expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({ name: 'Item', category, description: null, sourceId: null, version: 1 });
    }
    expect(await db.heritageItem.count({ where: { villageId } })).toBe(2);
  });
  it.each(['EDITOR', 'REVIEWER', 'ADMIN'] as const)('PATCH as %s preserves omissions, resets PENDING and increments once', async actor => {
    const item = await create();
    if (actor !== 'EDITOR') await db.heritageItem.update({ where: { id: item.id }, data: { verificationStatus: 'VERIFIED' } });
    const response = await call('patch', item.id, actor).send({ version: 1, name: 'Updated' }); expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ ...body(), name: 'Updated', version: 2, verificationStatus: 'PENDING' });
    expect(await row(item.id)).toMatchObject({ version: 2, updatedById: actors[actor].id });
    const entries = await audits(item.id); expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ action: 'UPDATE', actorId: actors[actor].id,
      before: { name: body().name, version: 1 }, after: { name: 'Updated', version: 2 } });
    const before = await row(item.id); const stale = await call('patch', item.id, actor).send({ version: 1, name: 'Stale' });
    expect(stale.status).toBe(409); expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(await row(item.id)).toEqual(before); expect(await audits(item.id)).toHaveLength(2);
  });
  it('updates category and clears nullable description/source', async () => {
    const item = await create(); const fields = { category: 'FOOD', description: null, sourceId: null };
    const response = await call('patch', item.id).send({ version: 1, ...fields }); expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ ...fields, name: body().name, version: 2 });
    expect((await audits(item.id)).at(-1)?.after).toMatchObject(fields);
  });
  it('rejects other/no-creator edits and reviewed records for EDITOR', async () => {
    const item = await create(); const other = await call('patch', item.id, 'OTHER_EDITOR').send({ version: 1, name: 'X' });
    expect(other.status).toBe(403); expect(other.body.error.code).toBe('HERITAGE_EDIT_FORBIDDEN');
    await db.heritageItem.update({ where: { id: item.id }, data: { createdById: null } });
    expect((await call('patch', item.id).send({ version: 1, name: 'X' })).status).toBe(403);
    for (const verificationStatus of ['VERIFIED', 'REJECTED'] as const) {
      await db.heritageItem.update({ where: { id: item.id }, data: { createdById: actors.EDITOR.id, verificationStatus } });
      const response = await call('patch', item.id).send({ version: 1, name: 'X' });
      expect(response.status).toBe(403); expect(response.body.error.code).toBe('CHANGE_REQUEST_REQUIRED');
    }
    expect(await audits(item.id)).toHaveLength(1);
  });
  it.each(['post', 'patch', 'delete'] as const)('%s requires valid authentication and supported token roles', async method => {
    const item = await create(); const path = method === 'post' ? `/api/v1/villages/${villageId}/heritage` : `/api/v1/heritage/${item.id}`;
    const unsupported = jwt.sign({ role: 'VIEWER' }, process.env.JWT_ACCESS_SECRET!, { subject: actors.EDITOR.id });
    const expired = jwt.sign({ role: 'ADMIN' }, process.env.JWT_ACCESS_SECRET!, { subject: actors.ADMIN.id, expiresIn: -1 });
    for (const auth of ['', 'Bearer invalid', `Bearer ${unsupported}`, `Bearer ${expired}`]) {
      const req = request(app)[method](path); if (auth) req.set('Authorization', auth);
      expect((await req.send({ version: 1, name: 'X' })).status).toBe(401);
    }
    expect(await audits(item.id)).toHaveLength(1);
  });
  it.each(['verificationStatus','createdById','updatedById','deletedAt','villageId','unknown'])(
    'rejects protected %s on POST/PATCH without writes', async key => {
      const item = await create();
      expect((await call('post').send({ ...body(), [key]: 'protected' })).status).toBe(400);
      expect((await call('patch', item.id).send({ version: 1, name: 'X', [key]: 'protected' })).status).toBe(400);
      expect(await row(item.id)).toMatchObject({ version: 1 }); expect(await audits(item.id)).toHaveLength(1);
    });
  it('rejects invalid fields, versions and UUIDs', async () => {
    const item = await create();
    for (const invalid of [{ category: 'INVALID' }, { category: null }, { name: null }, { name: ' ' }, { sourceId: 'invalid' }]) {
      expect((await call('post').send({ ...body(), ...invalid })).status).toBe(400);
      expect((await call('patch', item.id).send({ version: 1, ...invalid })).status).toBe(400);
    }
    for (const invalid of [{}, { version: 1 }, { version: 0, name: 'X' }, { name: 'X' }]) {
      expect((await call('patch', item.id).send(invalid)).status).toBe(400);
    }
    expect((await call('post').send({ name: 'X' })).status).toBe(400);
    expect((await call('patch', 'invalid').send({ version: 1, name: 'X' })).status).toBe(400);
    expect((await call('delete', 'invalid', 'ADMIN')).status).toBe(400);
    expect((await request(app).post('/api/v1/villages/invalid/heritage').set('Authorization', `Bearer ${actors.EDITOR.token}`).send(body())).status).toBe(400);
  });
  it('validates missing/deleted villages and changed sources, allows unchanged deleted sources', async () => {
    const item = await create(); const deleted = await db.source.create({ data: { title: 'Deleted source', sourceType: 'BOOK', deletedAt: new Date() } });
    for (const invalid of [randomUUID(), deleted.id]) {
      expect((await call('post').send({ ...body(), sourceId: invalid })).status).toBe(404);
      expect((await call('patch', item.id).send({ version: 1, sourceId: invalid })).status).toBe(404);
    }
    await db.source.update({ where: { id: sourceId }, data: { deletedAt: new Date() } });
    expect((await call('patch', item.id).send({ version: 1, sourceId, name: 'Unrelated' })).status).toBe(200);
    const valid = await db.source.create({ data: { title: 'Valid source', sourceType: 'BOOK' } });
    expect((await call('patch', item.id).send({ version: 2, sourceId: valid.id })).status).toBe(200);
    expect((await request(app).post(`/api/v1/villages/${randomUUID()}/heritage`).set('Authorization', `Bearer ${actors.EDITOR.token}`).send(body())).status).toBe(404);
    await db.village.update({ where: { id: villageId }, data: { deletedAt: new Date() } });
    expect((await call('post').send(body())).status).toBe(404);
    expect((await call('patch', item.id).send({ version: 3, name: 'X' })).status).toBe(404);
    expect((await call('delete', item.id, 'ADMIN')).status).toBe(404);
    expect((await request(app).get(`/api/v1/heritage/${item.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/villages/${villageId}/heritage`)).status).toBe(404);
  });
  it.each(['post', 'patch', 'delete'] as const)('rolls back %s when PostgreSQL rejects audit insertion', async method => {
    const item = method === 'post' ? undefined : await create(); const before = item ? await row(item.id) : undefined;
    const count = await db.heritageItem.count({ where: { villageId } }); const requestId = `heritage-audit-fail-${randomUUID()}`;
    const req = call(method, item?.id, 'ADMIN').set('X-Request-Id', requestId);
    const response = await (method === 'delete' ? req : req.send(method === 'post' ? body() : { version: 1, name: 'Rollback' }));
    expect(response.status).toBe(500); expect(await db.heritageItem.count({ where: { villageId } })).toBe(count);
    expect(await db.auditLog.count({ where: { requestId } })).toBe(0);
    if (item) { expect(await row(item.id)).toEqual(before); expect(await audits(item.id)).toHaveLength(1); }
  });
  it('allows exactly one concurrent versioned update', async () => {
    const item = await create(); const results = await Promise.all(['First','Second'].map(name => call('patch', item.id, 'ADMIN').send({ version: 1, name })));
    expect(results.map(result => result.status).sort()).toEqual([200,409]);
    expect(results.find(result => result.status === 409)?.body.error.code).toBe('VERSION_CONFLICT');
    expect(await row(item.id)).toMatchObject({ version: 2, name: results.find(result => result.status === 200)!.body.data.name });
    expect(await audits(item.id)).toHaveLength(2);
  });
  it.each(['EDITOR','REVIEWER'] as const)('forbids DELETE by %s', async actor => {
    const item = await create(); expect((await call('delete', item.id, actor)).status).toBe(403);
    expect(await row(item.id)).toMatchObject({ deletedAt: null, version: 1 }); expect(await audits(item.id)).toHaveLength(1);
  });
  it('soft-deletes once, preserves row/version, excludes reads and audits accurate values', async () => {
    const item = await create(); const response = await call('delete', item.id, 'ADMIN');
    expect(response.status).toBe(204); expect(response.text).toBe(''); const stored = await row(item.id);
    expect(stored).toMatchObject({ version: 1, deletedAt: expect.any(Date), updatedById: actors.ADMIN.id });
    expect((await request(app).get(`/api/v1/heritage/${item.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/villages/${villageId}/heritage`)).body.data).toEqual([]);
    expect((await call('delete', item.id, 'ADMIN')).status).toBe(404);
    const entries = await audits(item.id); expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ action: 'DELETE', actorId: actors.ADMIN.id,
      before: { ...body(), version: 1, deletedAt: null }, after: { ...body(), version: 1, deletedAt: stored.deletedAt!.toISOString() } });
  });
  it('handles concurrent edit/delete with an accurate locked deletion snapshot', async () => {
    const item = await create(); const [edit, deletion] = await Promise.all([
      call('patch', item.id, 'ADMIN').send({ version: 1, name: 'Concurrent' }), call('delete', item.id, 'ADMIN')]);
    expect(deletion.status).toBe(204); expect([200,404]).toContain(edit.status);
    const stored = await row(item.id); expect(stored.deletedAt).toBeInstanceOf(Date);
    const entries = await audits(item.id); expect(entries).toHaveLength(edit.status === 200 ? 3 : 2);
    expect(entries.find(entry => entry.action === 'DELETE')?.before).toMatchObject({ name: stored.name, version: stored.version });
  });
  it('allows only one simultaneous deletion', async () => {
    const item = await create(); const results = await Promise.all([call('delete', item.id, 'ADMIN'), call('delete', item.id, 'ADMIN')]);
    expect(results.map(result => result.status).sort()).toEqual([204,404]); expect(await audits(item.id)).toHaveLength(2);
  });
});
