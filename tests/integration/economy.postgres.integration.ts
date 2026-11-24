import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import type { Express } from 'express';
import type { PrismaClient, Role } from '@prisma/client';
import type { Redis } from 'ioredis';
import { validateEconomyTarget } from '../../scripts/economy-integration-safety.mjs';

let db: PrismaClient;
let appDb: PrismaClient;
let redis: Redis;
let app: Express;
let villageId: string;
let sourceId: string;
let governorateId: string;
const actors = {} as Record<Role | 'OTHER_EDITOR', { id: string; token: string }>;
const secret = process.env.JWT_ACCESS_SECRET!;

beforeAll(async () => {
  const { token, name } = validateEconomyTarget(process.env);
  const { PrismaClient } = await import('@prisma/client');
  db = new PrismaClient({ log: [] });
  const identity = await db.$queryRaw<Array<{ database: string; username: string }>>`
    SELECT current_database() AS database, current_user AS username`;
  expect(identity).toEqual([{ database: name, username: name }]);
  const guard = await db.$queryRaw<Array<{ token: string }>>`
    SELECT shobj_description(oid, 'pg_database') AS token FROM pg_database WHERE datname = current_database()`;
  expect(guard).toEqual([{ token }]);
  const { Redis } = await import('ioredis');
  redis = new Redis(process.env.REDIS_URL!, { lazyConnect: true, retryStrategy: () => null });
  await redis.connect();
  expect(await redis.get('economy-integration-guard')).toBe(token);
  // All writes, including failure injection, occur only after both identities are verified.
  await db.$executeRawUnsafe(`CREATE FUNCTION economy_reject_test_audit() RETURNS trigger AS $$
    BEGIN
      IF NEW.request_id LIKE 'economy-audit-fail-%' THEN
        RAISE EXCEPTION 'Synthetic audit insertion failure';
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql`);
  await db.$executeRawUnsafe(`CREATE TRIGGER economy_test_audit_failure BEFORE INSERT ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION economy_reject_test_audit()`);
  for (const key of ['EDITOR', 'OTHER_EDITOR', 'REVIEWER', 'ADMIN'] as const) {
    const role = key === 'OTHER_EDITOR' ? 'EDITOR' : key;
    const actor = await db.user.create({ data: { email: `${randomUUID()}@economy.invalid`,
      fullName: 'Synthetic Economy actor', passwordHash: 'not-used', role } });
    actors[key] = { id: actor.id, token: jwt.sign({ role }, secret, { subject: actor.id, expiresIn: '10m' }) };
  }
  const governorate = await db.governorate.create({ data: {
    code: randomUUID(), nameAr: `Synthetic ${randomUUID()}`, nameEn: `Synthetic ${randomUUID()}`,
  } });
  governorateId = governorate.id;
  app = (await import('../../src/app.js')).createApp();
  appDb = (await import('../../src/shared/db.js')).prisma;
}, 30000);

beforeEach(async () => {
  const village = await db.village.create({ data: { slug: `economy-${randomUUID()}`,
    nameAr: 'Synthetic Economy village', governorateId } });
  villageId = village.id;
  const source = await db.source.create({ data: { title: 'Synthetic Economy source', sourceType: 'BOOK' } });
  sourceId = source.id;
});

afterAll(async () => {
  if (appDb) await appDb.$disconnect();
  if (app) (await import('../../src/shared/cache.js')).redis.disconnect();
  redis?.disconnect();
  if (db) await db.$disconnect();
  // The runner removes the entire disposable environment; no broad row cleanup is needed.
});

function call(method: 'post' | 'patch' | 'delete', id?: string, actor: keyof typeof actors = 'EDITOR') {
  const path = method === 'post' ? `/api/v1/villages/${villageId}/economy` : `/api/v1/economy/${id}`;
  return request(app)[method](path).set('Authorization', `Bearer ${actors[actor].token}`);
}
function body() { return { name: 'Synthetic olives', category: 'CROP', sourceId,
  description: 'Original description', isMajor: true, asOfYear: 2020 }; }
async function create() {
  const response = await call('post').send(body());
  expect(response.status).toBe(201);
  return response.body.data as { id: string; version: number };
}
const row = (id: string) => db.economicActivity.findUniqueOrThrow({ where: { id } });
const audits = (id: string) => db.auditLog.findMany({ where: { entityType: 'EconomicActivity', entityId: id }, orderBy: { createdAt: 'asc' } });

describe('Economy HTTP API with disposable PostgreSQL and Redis', () => {
  it('creates PENDING/version 1, reads publicly and records exactly one CREATE audit', async () => {
    const activity = await create();
    const stored = await row(activity.id);
    expect(stored).toMatchObject({ ...body(), verificationStatus: 'PENDING', version: 1,
      createdById: actors.EDITOR.id, updatedById: actors.EDITOR.id, deletedAt: null });
    const response = await request(app).get(`/api/v1/economy/${activity.id}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ ...body(), id: activity.id, version: 1, verificationStatus: 'PENDING' });
    expect(response.body.data).not.toHaveProperty('createdById');
    expect(response.body.data).not.toHaveProperty('deletedAt');
    expect(await audits(activity.id)).toEqual([expect.objectContaining({ action: 'CREATE',
      actorId: actors.EDITOR.id, before: null, after: expect.objectContaining({ ...body(), version: 1 }) })]);
    // Production-mode rate limiting must actually write to the disposable Redis instance.
    expect((await redis.keys('rl:global:*')).length).toBeGreaterThan(0);
  });

  it.each(['EDITOR', 'REVIEWER', 'ADMIN'] as const)('PATCH by %s preserves omitted fields and increments once', async actor => {
    const activity = await create();
    if (actor !== 'EDITOR') await db.economicActivity.update({ where: { id: activity.id }, data: { verificationStatus: 'VERIFIED' } });
    const before = await row(activity.id);
    const response = await call('patch', activity.id, actor).send({ version: 1, name: 'Updated olives' });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ ...body(), name: 'Updated olives', version: 2, verificationStatus: 'PENDING' });
    expect(await row(activity.id)).toMatchObject({ version: 2, updatedById: actors[actor].id, verificationStatus: 'PENDING' });
    const entries = await audits(activity.id);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ action: 'UPDATE', actorId: actors[actor].id,
      before: { name: before.name, version: 1, verificationStatus: before.verificationStatus },
      after: { name: 'Updated olives', version: 2, verificationStatus: 'PENDING' } });
  });

  it('denies another editor and denies editor changes to reviewed records', async () => {
    const activity = await create();
    const response = await call('patch', activity.id, 'OTHER_EDITOR').send({ version: 1, name: 'Forbidden' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ECONOMY_EDIT_FORBIDDEN');
    await db.economicActivity.update({ where: { id: activity.id }, data: { verificationStatus: 'VERIFIED' } });
    const reviewed = await call('patch', activity.id).send({ version: 1, name: 'Forbidden' });
    expect(reviewed.status).toBe(403);
    expect(reviewed.body.error.code).toBe('CHANGE_REQUEST_REQUIRED');
    expect(await row(activity.id)).toMatchObject({ name: body().name, version: 1 });
    expect(await audits(activity.id)).toHaveLength(1);
  });

  it.each(['post', 'patch', 'delete'] as const)('%s rejects missing, invalid and unsupported-role tokens', async method => {
    const activity = await create();
    const path = method === 'post' ? `/api/v1/villages/${villageId}/economy` : `/api/v1/economy/${activity.id}`;
    const invalidRole = jwt.sign({ role: 'VIEWER' }, secret, { subject: actors.EDITOR.id });
    for (const auth of ['', 'Bearer invalid', `Bearer ${invalidRole}`]) {
      const req = request(app)[method](path);
      if (auth) req.set('Authorization', auth);
      expect((await req.send({ version: 1, name: 'Forbidden' })).status).toBe(401);
    }
    expect(await row(activity.id)).toMatchObject({ version: 1, deletedAt: null });
    expect(await audits(activity.id)).toHaveLength(1);
  });

  it('returns VERSION_CONFLICT for stale updates without changing data or auditing', async () => {
    const activity = await create();
    expect((await call('patch', activity.id).send({ version: 1, name: 'Winner' })).status).toBe(200);
    const before = await row(activity.id);
    const response = await call('patch', activity.id).send({ version: 1, name: 'Stale' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('VERSION_CONFLICT');
    expect(await row(activity.id)).toEqual(before);
    expect(await audits(activity.id)).toHaveLength(2);
  });

  it.each(['verificationStatus', 'createdById', 'updatedById', 'deletedAt'])('rejects protected field %s', async field => {
    const activity = await create();
    const response = await call('patch', activity.id).send({ version: 1, name: 'Forbidden', [field]: 'forbidden' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(await row(activity.id)).toMatchObject({ version: 1, name: body().name });
    expect(await audits(activity.id)).toHaveLength(1);
  });

  it('requires an active changed source and accepts a valid replacement', async () => {
    const activity = await create();
    const deleted = await db.source.create({ data: { title: 'Deleted synthetic source', sourceType: 'BOOK', deletedAt: new Date() } });
    for (const invalid of [randomUUID(), deleted.id]) {
      expect((await call('patch', activity.id).send({ version: 1, sourceId: invalid })).status).toBe(404);
      expect(await row(activity.id)).toMatchObject({ version: 1, sourceId });
      expect(await audits(activity.id)).toHaveLength(1);
    }
    const valid = await db.source.create({ data: { title: 'Replacement synthetic source', sourceType: 'BOOK' } });
    expect((await call('patch', activity.id).send({ version: 1, sourceId: valid.id })).status).toBe(200);
    expect(await row(activity.id)).toMatchObject({ version: 2, sourceId: valid.id });
  });

  it.each(['post', 'patch', 'delete'] as const)('rolls back %s when PostgreSQL rejects the audit insert', async method => {
    const activity = method === 'post' ? undefined : await create();
    const before = activity ? await row(activity.id) : undefined;
    const count = await db.economicActivity.count({ where: { villageId } });
    const requestId = `economy-audit-fail-${randomUUID()}`;
    const req = call(method, activity?.id, 'ADMIN').set('X-Request-Id', requestId);
    const response = await (method === 'delete' ? req : req.send(method === 'post' ? body() : { version: 1, name: 'Must roll back' }));
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(await db.economicActivity.count({ where: { villageId } })).toBe(count);
    expect(await db.auditLog.count({ where: { requestId } })).toBe(0);
    if (activity) {
      expect(await row(activity.id)).toEqual(before);
      expect(await audits(activity.id)).toHaveLength(1);
    }
  });

  it('allows exactly one winner for two concurrent versioned HTTP updates', async () => {
    const activity = await create();
    const results = await Promise.all(['First', 'Second'].map(name =>
      call('patch', activity.id, 'ADMIN').send({ version: 1, name })));
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    expect(results.find(result => result.status === 409)?.body.error.code).toBe('VERSION_CONFLICT');
    const winner = results.find(result => result.status === 200)!.body.data;
    expect(await row(activity.id)).toMatchObject({ name: winner.name, version: 2 });
    const entries = await audits(activity.id);
    expect(entries).toHaveLength(2);
    expect(entries.filter(entry => entry.action === 'UPDATE')).toEqual([expect.objectContaining({
      actorId: actors.ADMIN.id, before: expect.objectContaining({ version: 1 }),
      after: expect.objectContaining({ version: 2, name: winner.name }),
    })]);
  });

  it.each(['EDITOR', 'REVIEWER'] as const)('returns 403 for DELETE by the disallowed role %s', async actor => {
    const activity = await create();
    const response = await call('delete', activity.id, actor);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(await row(activity.id)).toMatchObject({ deletedAt: null, version: 1 });
    expect(await audits(activity.id)).toHaveLength(1);
  });

  it('ADMIN soft-deletes, retains the row, hides it publicly, audits once and returns 404 on repeat', async () => {
    const activity = await create();
    expect((await request(app).get(`/api/v1/villages/${villageId}/economy`)).body.data).toHaveLength(1);
    const response = await call('delete', activity.id, 'ADMIN');
    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    const stored = await row(activity.id);
    expect(stored).toMatchObject({ deletedAt: expect.any(Date), updatedById: actors.ADMIN.id, version: 1 });
    expect((await request(app).get(`/api/v1/economy/${activity.id}`)).status).toBe(404);
    const list = await request(app).get(`/api/v1/villages/${villageId}/economy`);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);
    expect((await call('delete', activity.id, 'ADMIN')).status).toBe(404);
    const entries = await audits(activity.id);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ action: 'DELETE', actorId: actors.ADMIN.id,
      before: { ...body(), version: 1, deletedAt: null },
      after: { ...body(), version: 1, deletedAt: stored.deletedAt!.toISOString() } });
  });
});
