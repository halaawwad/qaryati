import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { sourceRepository as Repository } from '../../src/modules/sources/sources.repository.js';
import type { auditRepository as AuditRepository } from '../../src/modules/audit/audit.repository.js';

let db: PrismaClient;
let repository: typeof Repository;
let auditRepository: typeof AuditRepository;
let app: Express;
const secret = 'sources-integration-secret-at-least-32-characters';
const users = new Set<string>();
const sources = new Set<string>();
const requests = new Set<string>();
const attemptedSources = new Set<string>();
let verified = false;

function validateTarget(): void {
  if (process.env.QARYATI_POSTGRES_INTEGRATION !== '1') throw new Error('PostgreSQL integration opt-in required');
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
        url.port !== '55433' || url.pathname !== '/qaryati_local' || url.hash ||
        [...url.searchParams.keys()].some(key => key !== 'schema') ||
        (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public')) throw new Error();
  } catch {
    throw new Error('Integration database target is not allowed');
  }
}

function requestId(): string {
  const id = randomUUID();
  requests.add(id);
  return id;
}

async function actor(): Promise<string> {
  const id = randomUUID();
  await db.user.create({ data: { id, email: `${id}@integration.invalid`, fullName: 'Integration test', passwordHash: 'unused', role: 'ADMIN' } });
  users.add(id);
  return id;
}

async function fixture(actorId: string) {
  const result = await repository.create({ title: `integration-${randomUUID()}`, sourceType: 'BOOK' }, { actorId, requestId: requestId() });
  sources.add(result.id);
  return result;
}

function rejectedAs(error: unknown, allowed: string[]): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string' && allowed.includes(error.code);
}

// Re-throw without the original stack or Prisma metadata, which can contain connection details.
function safeFailure(error: unknown): never {
  if (error instanceof Error && error.name === 'AssertionError') throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(error.code) ? error.code : 'UNKNOWN';
  throw new Error(`Integration operation failed (code: ${code}); inspect the failing test name`);
}

function safeTest<T>(fn: (value: T) => Promise<void>): (value: T) => Promise<void> {
  return async value => { try { await fn(value); } catch (error) { safeFailure(error); } };
}

beforeAll(async () => {
  validateTarget();
  // Dynamic imports ensure no Prisma client is initialized before validation.
  try {
    // Use a quiet test-only client; production logging remains unchanged.
    const { PrismaClient } = await import('@prisma/client');
    db = new PrismaClient({ log: [] });
    vi.doMock('../../src/shared/db.js', () => ({ prisma: db }));
    const identity = await db.$queryRaw<Array<{ database: string; username: string }>>`SELECT current_database() AS database, current_user AS username`;
    if (identity.length !== 1 || identity[0]?.database !== 'qaryati_local' || identity[0]?.username !== 'qaryati_local') {
      throw new Error('Integration database identity is not allowed');
    }
    verified = true;
    repository = (await import('../../src/modules/sources/sources.repository.js')).sourceRepository;
    auditRepository = (await import('../../src/modules/audit/audit.repository.js')).auditRepository;
    vi.stubEnv('NODE_ENV','test'); vi.stubEnv('LOG_LEVEL','silent'); vi.stubEnv('RATE_LIMIT_ENABLED','false');
    vi.stubEnv('REDIS_URL','redis://127.0.0.1:6379'); vi.stubEnv('JWT_ACCESS_SECRET',secret);
    vi.doMock('../../src/shared/cache.js',()=>({redis:{}}));
    app = (await import('../../src/app.js')).createApp();
  } catch {
    if (db) { try { await db.$disconnect(); } catch { /* Report only the safe error below. */ } }
    throw new Error('Could not verify integration database identity');
  }
});

afterEach(async () => { try {
  vi.restoreAllMocks();
  if (!verified) return;
  // Exact IDs only; do not remove fixtures belonging to other runs.
  const auditRows = await db.auditLog.findMany({ where: {
    entityType: 'Source', entityId: { in: [...sources] },
  }, select: { id: true, actorId: true, requestId: true } });
  if (auditRows.some(row => !row.actorId || !users.has(row.actorId) || !row.requestId || !requests.has(row.requestId))) {
    throw new Error('Audit fixture ownership could not be established');
  }
  await db.auditLog.deleteMany({ where: { id: { in: auditRows.map(row => row.id) } } });
  await db.source.deleteMany({ where: { id: { in: [...sources] } } });
  await db.user.deleteMany({ where: { id: { in: [...users] } } });
  requests.clear(); sources.clear(); users.clear(); attemptedSources.clear();
  } catch (error) { safeFailure(error); }
});

afterAll(async () => { try { if (db) await db.$disconnect(); } catch (error) { safeFailure(error); } });

describe('Sources with PostgreSQL', () => {
  it('persists a full URL while sanitizing CREATE, UPDATE and DELETE audit snapshots', safeTest(async () => {
    const actorId=await actor(), token=jwt.sign({role:'ADMIN'},secret,{subject:actorId}), createId=requestId();
    const url='https://example.invalid/census?token=synthetic-secret#synthetic-fragment';
    const response=await request(app).post('/api/v1/sources').set('Authorization',`Bearer ${token}`).set('X-Request-Id',createId).send({title:'Sanitized source',sourceType:'BOOK',url});
    expect(response.status).toBe(201); const id:string=response.body.data.id; sources.add(id);
    expect(response.body.data.url).toBe(url); expect((await db.source.findUniqueOrThrow({where:{id}})).url).toBe(url);
    const created=await db.auditLog.findFirstOrThrow({where:{entityType:'Source',entityId:id,requestId:createId}});
    expect(created).toMatchObject({entityType:'Source',entityId:id,actorId,action:'CREATE',requestId:createId,after:{url:'https://example.invalid/census'}});
    expect(JSON.stringify(created.after)).not.toMatch(/synthetic-secret|synthetic-fragment/);
    const updateId=requestId(),patch=await request(app).patch(`/api/v1/sources/${id}`).set('Authorization',`Bearer ${token}`).set('X-Request-Id',updateId).send({expectedVersion:1,title:'Updated'});
    expect(patch.status).toBe(200);const updated=await db.auditLog.findFirstOrThrow({where:{requestId:updateId}});expect(updated).toMatchObject({before:{url:'https://example.invalid/census'},after:{url:'https://example.invalid/census'}});
    const deleteId=requestId(),removed=await request(app).delete(`/api/v1/sources/${id}`).set('Authorization',`Bearer ${token}`).set('X-Request-Id',deleteId).send({expectedVersion:2});
    expect(removed.status).toBe(200);const deleted=await db.auditLog.findFirstOrThrow({where:{requestId:deleteId}});expect(deleted).toMatchObject({before:{url:'https://example.invalid/census'},after:{url:'https://example.invalid/census'}});
    const empty=await fixture(actorId);expect((await db.auditLog.findFirstOrThrow({where:{entityType:'Source',entityId:empty.id,action:'CREATE'}})).after).toMatchObject({url:null});
  }));
  it('rolls back HTTP Source creation when a real audit constraint rejects the insert', safeTest(async()=>{
    const actorId=await actor(),token=jwt.sign({role:'ADMIN'},secret,{subject:actorId}),rid=requestId(),title=`rollback-${randomUUID()}`;
    await db.$executeRaw`ALTER TABLE audit_logs ADD CONSTRAINT sources_create_test_failure CHECK (action <> 'CREATE' OR entity_type <> 'Source') NOT VALID`;
    try {
      const response=await request(app).post('/api/v1/sources').set('Authorization',`Bearer ${token}`).set('X-Request-Id',rid).send({title,sourceType:'BOOK'});
      expect(response.status).toBe(500);expect(await db.source.count({where:{title}})).toBe(0);expect(await db.auditLog.count({where:{requestId:rid}})).toBe(0);
    } finally {await db.$executeRaw`ALTER TABLE audit_logs DROP CONSTRAINT sources_create_test_failure`;}
  }));
  it('enforces HTTP version boundaries without changing persisted state on failures', safeTest(async()=>{
    const actorId=await actor(),source=await fixture(actorId),token=jwt.sign({role:'ADMIN'},secret,{subject:actorId});
    await db.source.update({where:{id:source.id},data:{version:2147483647}});
    const before=await db.source.findUniqueOrThrow({where:{id:source.id}}),audits=await db.auditLog.count({where:{entityType:'Source',entityId:source.id}});
    const patch=(body:object,role='ADMIN')=>request(app).patch(`/api/v1/sources/${source.id}`).set('Authorization',`Bearer ${jwt.sign({role},secret,{subject:actorId})}`).set('X-Request-Id',requestId()).send(body);
    const del=(version:number)=>request(app).delete(`/api/v1/sources/${source.id}`).set('Authorization',`Bearer ${token}`).set('X-Request-Id',requestId()).send({expectedVersion:version});
    expect((await patch({expectedVersion:2147483648,title:'new'})).status).toBe(400);expect((await del(2147483648)).status).toBe(400);
    expect((await patch({expectedVersion:2147483647,title:before.title},'REVIEWER')).status).toBe(200);
    const stale=await patch({expectedVersion:2147483646,title:'new'});expect(stale.status).toBe(409);expect(stale.body.error.message).toBe('Source version conflict');
    const changed=await patch({expectedVersion:2147483647,title:'new'});expect(changed.status).toBe(409);expect(changed.body.error.code).toBe('CONFLICT');
    expect((await del(2147483647)).status).toBe(409);expect((await patch({expectedVersion:2147483647,title:'new'},'EDITOR')).status).toBe(409);
    expect(await db.source.findUniqueOrThrow({where:{id:source.id}})).toEqual(before);expect(await db.auditLog.count({where:{entityType:'Source',entityId:source.id}})).toBe(audits);
  }));
  it.each(['patch','delete'] as const)('commits the last valid %s increment with audit',safeTest(async(operation:'patch'|'delete')=>{
    const actorId=await actor(),source=await fixture(actorId),token=jwt.sign({role:'ADMIN'},secret,{subject:actorId}),rid=requestId();
    await db.source.update({where:{id:source.id},data:{version:2147483646}});
    const req=operation==='patch'?request(app).patch(`/api/v1/sources/${source.id}`).send({expectedVersion:2147483646,title:'last'}):request(app).delete(`/api/v1/sources/${source.id}`).send({expectedVersion:2147483646});
    const response=await req.set('Authorization',`Bearer ${token}`).set('X-Request-Id',rid);expect(response.status).toBe(200);expect(response.body.data.version).toBe(2147483647);
    const row=await db.source.findUniqueOrThrow({where:{id:source.id}});expect(row.version).toBe(2147483647);expect(row.deletedAt===null).toBe(operation==='patch');
    expect(await db.auditLog.findFirstOrThrow({where:{requestId:rid}})).toMatchObject({entityType:'Source',entityId:source.id,actorId,action:operation==='patch'?'UPDATE':'DELETE',before:{version:2147483646},after:{version:2147483647}});
  }));
  it('prevents overflow when two last-version updates contend',safeTest(async()=>{
    const actorId=await actor(),source=await fixture(actorId),token=jwt.sign({role:'ADMIN'},secret,{subject:actorId});
    await db.source.update({where:{id:source.id},data:{version:2147483646}});
    let release!:()=>void,ready!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),locked=new Promise<void>(resolve=>{ready=resolve;});let holder=0;
    const gate=db.$transaction(async tx=>{holder=(await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;await tx.$queryRaw`SELECT id FROM sources WHERE id=${source.id}::uuid FOR UPDATE`;ready();await held;},{timeout:15000});
    let first:Promise<request.Response>|undefined,second:Promise<request.Response>|undefined;
    const firstId=requestId(),secondId=requestId();
    try {
      await Promise.race([locked,delay(5000).then(()=>{throw new Error('Lock timeout');})]);
      const call=(rid:string,title:string)=>Promise.resolve(request(app).patch(`/api/v1/sources/${source.id}`).set('Authorization',`Bearer ${token}`).set('X-Request-Id',rid).send({expectedVersion:2147483646,title}));
      first=call(firstId,'first');second=call(secondId,'second');const end=Date.now()+5000;let observed=false;
      while(Date.now()<end){const rows=await db.$queryRaw<Array<{pid:number; blockers:number[]}>>`SELECT pid,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0 AND datname=current_database()`;const direct=rows.filter(r=>r.blockers.includes(holder));if(direct.length>=2 || (direct.length>0 && rows.some(r=>!direct.includes(r)&&r.blockers.some(pid=>direct.some(first=>first.pid===pid))))){observed=true;break;}await delay(30);}
      expect(observed).toBe(true);
    } finally {release();await gate;await Promise.allSettled([...(first?[first]:[]),...(second?[second]:[])]);}
    const responses=await Promise.all([first!,second!]);expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
    const row=await db.source.findUniqueOrThrow({where:{id:source.id}});expect(row.version).toBe(2147483647);expect(['first','second']).toContain(row.title);
    expect(await db.auditLog.count({where:{requestId:{in:[firstId,secondId]},action:'UPDATE'}})).toBe(1);
  }),20000);
  it('creates a source and audit atomically', safeTest(async () => {
    const actorId = await actor();
    const source = await fixture(actorId);
    const row = await db.source.findUniqueOrThrow({ where: { id: source.id } });
    const audits = await db.auditLog.findMany({ where: { entityId: source.id } });
    expect(row).toMatchObject({ version: 1, createdById: actorId, deletedAt: null });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'CREATE', actorId, entityType: 'Source', after: { id: source.id, version: 1, title: source.title } });
  }));

  it('updates with version checking and rejects a stale version', safeTest(async () => {
    const actorId = await actor(); const source = await fixture(actorId);
    const context = { actorId, role: 'ADMIN' as const, requestId: requestId() };
    const updated = await repository.update(source.id, { expectedVersion: 1, title: 'Updated' }, context);
    expect(updated).toMatchObject({ title: 'Updated', version: 2 });
    const audit = await db.auditLog.findFirstOrThrow({ where: { requestId: context.requestId } });
    expect(audit).toMatchObject({ action: 'UPDATE', before: { title: source.title, version: 1 }, after: { title: 'Updated', version: 2 } });
    await expect(repository.update(source.id, { expectedVersion: 1, title: 'Stale' }, { ...context, requestId: requestId() })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await db.source.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ title: 'Updated', version: 2 });
    expect(await db.auditLog.count({ where: { entityId: source.id } })).toBe(2);
  }));

  it('soft deletes and records an audit', safeTest(async () => {
    const actorId = await actor(); const source = await fixture(actorId);
    const request = requestId();
    await repository.softDelete(source.id, { expectedVersion: 1 }, { actorId, role: 'ADMIN', requestId: request });
    expect(await db.source.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ version: 2, deletedAt: expect.any(Date) });
    expect(await repository.findById(source.id)).toBeNull();
    expect(await db.auditLog.findFirstOrThrow({ where: { requestId: request } })).toMatchObject({ action: 'DELETE', actorId, before: { version: 1, deletedAt: null }, after: { version: 2, deletedAt: expect.any(String) } });
  }));

  it.each(['create', 'update', 'delete'] as const)('rolls back %s when the database rejects audit insertion', safeTest(async (operation: 'create' | 'update' | 'delete') => {
    const actorId = await actor();
    const source = operation === 'create' ? undefined : await fixture(actorId);
    const request = requestId();
    const originalCount = source ? await db.auditLog.count({ where: { entityId: source.id } }) : 0;
    const spy = vi.spyOn(auditRepository, 'create').mockImplementation(async (input, client) => {
      if (operation === 'create') attemptedSources.add(input.entityId);
      if (!client) throw new Error('Expected a transaction client');
      return client.auditLog.create({ data: { entityType: input.entityType, entityId: input.entityId, action: input.action, actorId: randomUUID(), requestId: input.requestId } });
    });
    const context = { actorId, role: 'ADMIN' as const, requestId: request };
    const attempt = operation === 'create'
      ? repository.create({ title: `rollback-${randomUUID()}`, sourceType: 'BOOK' }, context)
      : operation === 'update'
        ? repository.update(source!.id, { expectedVersion: 1, title: 'Should roll back' }, context)
        : repository.softDelete(source!.id, { expectedVersion: 1 }, context);
    await expect(attempt).rejects.toMatchObject({ code: 'P2003' });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
    if (source) {
      expect(await db.source.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ title: source.title, version: 1, deletedAt: null });
      expect(await db.auditLog.count({ where: { entityId: source.id } })).toBe(originalCount);
    } else {
      expect(attemptedSources.size).toBe(1);
      expect(await db.source.count({ where: { id: { in: [...attemptedSources] } } })).toBe(0);
    }
    expect(await db.auditLog.count({ where: { requestId: request } })).toBe(0);
  }));

  it.each(['update', 'delete'] as const)('resolves competing update and %s with one winner', safeTest(async (other: 'update' | 'delete') => {
    const actorId = await actor(); const source = await fixture(actorId);
    const first = requestId(); const second = requestId();
    const context = { actorId, role: 'ADMIN' as const };
    const results = await Promise.allSettled([
      repository.update(source.id, { expectedVersion: 1, title: 'First' }, { ...context, requestId: first }),
      other === 'update'
        ? repository.update(source.id, { expectedVersion: 1, title: 'Second' }, { ...context, requestId: second })
        : repository.softDelete(source.id, { expectedVersion: 1 }, { ...context, requestId: second }),
    ]);
    const wins = results.filter(result => result.status === 'fulfilled');
    const losses = results.filter(result => result.status === 'rejected');
    expect(wins).toHaveLength(1); expect(losses).toHaveLength(1);
    const loss = losses[0];
    if (!loss || loss.status !== 'rejected') throw new Error('Expected a rejected mutation');
    expect(rejectedAs(loss.reason, other === 'delete' ? ['CONFLICT', 'NOT_FOUND', 'P2025', 'P2034'] : ['CONFLICT', 'P2025', 'P2034'])).toBe(true);
    const row = await db.source.findUniqueOrThrow({ where: { id: source.id } });
    expect(row.version).toBe(2);
    const audits = await db.auditLog.findMany({ where: { requestId: { in: [first, second] } } });
    expect(audits).toHaveLength(1);
    if (row.deletedAt) {
      expect(other).toBe('delete'); expect(audits[0]?.action).toBe('DELETE');
    } else {
      expect(['First', 'Second']).toContain(row.title); expect(audits[0]?.action).toBe('UPDATE');
    }
  }));
});
