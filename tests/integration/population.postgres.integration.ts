import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Express } from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { populationService as PopulationService } from '../../src/modules/population/population.service.js';
import type { populationRepository as PopulationRepository } from '../../src/modules/population/population.repository.js';
import type { villageService as VillageService } from '../../src/modules/villages/villages.service.js';
import type { villageRepository as VillageRepository } from '../../src/modules/villages/villages.repository.js';
import type { auditRepository as AuditRepository } from '../../src/modules/audit/audit.repository.js';

let db: PrismaClient;
let population: typeof PopulationService;
let populationRepository: typeof PopulationRepository;
let village: typeof VillageService;
let villageRepository: typeof VillageRepository;
let auditRepository: typeof AuditRepository;
let app: Express;
let verified = false;
const ids = { users: new Set<string>(), governors: new Set<string>(), villages: new Set<string>(), sources: new Set<string>(), records: new Set<string>(), requests: new Set<string>() };

function validateTarget(): void {
 if (process.env.QARYATI_POSTGRES_INTEGRATION !== '1') throw new Error('PostgreSQL integration opt-in required');
 try {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== '55433' ||
   url.pathname !== '/qaryati_local' || url.hash || [...url.searchParams.keys()].some(key => key !== 'schema') ||
   (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public')) throw new Error();
 } catch { throw new Error('Integration database target is not allowed'); }
}
function requestId(): string { const id = randomUUID(); ids.requests.add(id); return id; }
function safeTest(fn: () => Promise<void>): () => Promise<void> {
 return async () => { try { await fn(); } catch (error) {
  if (error instanceof Error && error.name === 'AssertionError') throw error;
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(error.code) ? error.code : 'UNKNOWN';
  throw new Error(`Integration operation failed (code: ${code}); inspect the failing test name`);
 } };
}
const context = (actorId: string) => ({actorId, role:'ADMIN' as const, requestId:requestId()});
function gate() {
 let release!: () => void;
 const wait = new Promise<void>(resolve => { release = resolve; });
 return {wait, release};
}
async function backend(client: Prisma.TransactionClient): Promise<number> {
 const rows = await client.$queryRaw<Array<{pid: number}>>`SELECT pg_backend_pid() AS pid`;
 return rows[0]!.pid;
}
async function blockedBy(waiter: number, blocker: number): Promise<void> {
 const deadline = Date.now() + 4000;
 while (Date.now() < deadline) {
  const rows = await db.$queryRaw<Array<{blocked: boolean}>>`SELECT ${blocker}::integer = ANY(pg_blocking_pids(${waiter}::integer)) AS blocked`;
  if (rows[0]?.blocked) return;
  await delay(30);
 }
 throw new Error('Expected PostgreSQL lock contention was not observed');
}
// Await started operations even on failure, with handlers attached immediately.
function settled<T>(promise: Promise<T>) { return promise.then(value => ({ok:true as const, value}), error => ({ok:false as const, error})); }
function errorCode(error: unknown): unknown { return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined; }

beforeAll(async () => {
 validateTarget();
 try {
  const {PrismaClient} = await import('@prisma/client');
  db = new PrismaClient({log:[]});
  const identity = await db.$queryRaw<Array<{database:string; username:string}>>`SELECT current_database() AS database, current_user AS username`;
  if (identity.length !== 1 || identity[0]?.database !== 'qaryati_local' || identity[0]?.username !== 'qaryati_local') throw new Error();
  verified = true;
  vi.stubEnv('NODE_ENV','test');
  vi.stubEnv('LOG_LEVEL','silent');
  vi.stubEnv('RATE_LIMIT_ENABLED','false');
  vi.stubEnv('REDIS_URL','redis://127.0.0.1:6379');
  vi.stubEnv('JWT_ACCESS_SECRET','population-integration-test-secret-at-least-32-characters');
  vi.doMock('../../src/shared/db.js', () => ({prisma:db}));
  vi.doMock('../../src/shared/cache.js', () => ({redis:{}}));
  population = (await import('../../src/modules/population/population.service.js')).populationService;
  populationRepository = (await import('../../src/modules/population/population.repository.js')).populationRepository;
  village = (await import('../../src/modules/villages/villages.service.js')).villageService;
  villageRepository = (await import('../../src/modules/villages/villages.repository.js')).villageRepository;
  auditRepository = (await import('../../src/modules/audit/audit.repository.js')).auditRepository;
  app = (await import('../../src/app.js')).createApp();
 } catch {
  if (db) await db.$disconnect();
  throw new Error('Could not verify integration database identity or initialize test services');
 }
});
afterEach(async () => {
 vi.restoreAllMocks();
 if (!verified) return;
 const audits = await db.auditLog.findMany({where:{OR:[{entityId:{in:[...ids.records]}},{entityId:{in:[...ids.villages]}}]},select:{id:true,actorId:true,requestId:true}});
 if (audits.some(a => !a.actorId || !ids.users.has(a.actorId) || !a.requestId || !ids.requests.has(a.requestId))) throw new Error('Audit fixture ownership could not be established');
 await db.auditLog.deleteMany({where:{id:{in:audits.map(a=>a.id)}}});
 await db.populationRecord.deleteMany({where:{id:{in:[...ids.records]}}});
 await db.village.deleteMany({where:{id:{in:[...ids.villages]}}});
 await db.source.deleteMany({where:{id:{in:[...ids.sources]}}});
 await db.governorate.deleteMany({where:{id:{in:[...ids.governors]}}});
 await db.user.deleteMany({where:{id:{in:[...ids.users]}}});
 for (const set of Object.values(ids)) set.clear();
});
afterAll(async () => { if (db) await db.$disconnect(); });

async function fixture() {
 const actorId=randomUUID(), governorateId=randomUUID(), villageId=randomUUID(), sourceId=randomUUID(), otherSourceId=randomUUID(), id=randomUUID(), otherId=randomUUID();
 ids.users.add(actorId); ids.governors.add(governorateId); ids.villages.add(villageId); ids.sources.add(sourceId); ids.sources.add(otherSourceId); ids.records.add(id); ids.records.add(otherId);
 await db.user.create({data:{id:actorId,email:`${actorId}@integration.invalid`,fullName:'Integration',passwordHash:'unused',role:'ADMIN'}});
 await db.governorate.create({data:{id:governorateId,nameAr:`ar-${governorateId}`,nameEn:`en-${governorateId}`,code:`i-${governorateId}`}});
 await db.village.create({data:{id:villageId,governorateId,slug:`integration-${villageId}`,nameAr:'Integration'}});
 await db.source.createMany({data:[{id:sourceId,title:'first',sourceType:'BOOK'},{id:otherSourceId,title:'second',sourceType:'BOOK'}]});
 await db.populationRecord.createMany({data:[
  {id,villageId,sourceId,population:100,referenceYear:2020,referenceDate:new Date('2020-01-01T00:00:00Z'),isPreferred:true,needsReview:true,notes:'provenance',verificationStatus:'VERIFIED',verifiedById:actorId,verifiedAt:new Date('2021-01-01T00:00:00Z'),createdById:actorId,updatedById:actorId,version:3},
  {id:otherId,villageId,sourceId:otherSourceId,population:101,referenceYear:2020,isPreferred:false,createdById:actorId}
 ]});
 return {actorId,villageId,sourceId,otherSourceId,id,otherId};
}

// The first operation pauses after its real lock; the second records its backend PID
// immediately before requesting that lock. PostgreSQL confirms the wait relationship.
async function populationRace(first:'delete'|'patch', second:'delete'|'patch') {
 const f=await fixture(), held=gate(), firstLocked=gate(), secondReady=gate();
 let firstPid=0, secondPid=0;
 const originalDelete=populationRepository.findForDelete.bind(populationRepository);
 const originalUpdate=populationRepository.findForUpdate.bind(populationRepository);
 let deleteCalls=0, updateCalls=0;
 const wrap = <T>(kind:'delete'|'patch', original:(id:string, tx:Prisma.TransactionClient)=>Promise<T>) => async (id:string, tx:Prisma.TransactionClient):Promise<T> => {
  const call = kind === 'delete' ? ++deleteCalls : ++updateCalls;
  const isFirst = kind === first && call === 1;
  const pid=await backend(tx);
  if (!isFirst) { secondPid=pid; secondReady.release(); }
  const value=await original(id,tx);
  if (isFirst) { firstPid=pid; firstLocked.release(); await held.wait; }
  return value;
 };
 vi.spyOn(populationRepository,'findForDelete').mockImplementation(wrap('delete',originalDelete));
 vi.spyOn(populationRepository,'findForUpdate').mockImplementation(wrap('patch',originalUpdate));
 const firstContext=context(f.actorId), secondContext=context(f.actorId);
 const run=(kind:'delete'|'patch', ctx:ReturnType<typeof context>):Promise<unknown> => kind === 'delete' ? population.softDelete(f.id,ctx) : population.update(f.id,{expectedVersion:3,notes:'patched'},ctx);
 const a=settled(run(first,firstContext)); let b:ReturnType<typeof settled> | undefined;
 try {
  await Promise.race([firstLocked.wait,delay(4000).then(()=>{throw new Error('First lock timeout');})]);
  b=settled(run(second,secondContext));
  await Promise.race([secondReady.wait,delay(4000).then(()=>{throw new Error('Second lock timeout');})]);
  await blockedBy(secondPid,firstPid);
 } finally { held.release(); await a; if (b) await b; }
 return {f, firstContext, secondContext, a:await a, b:await b!};
}

describe('Population soft DELETE with PostgreSQL', () => {
 it('serializes concurrent DELETE requests and commits one DELETE audit', safeTest(async()=>{
  const r=await populationRace('delete','delete'); expect(r.a.ok).toBe(true); expect(r.b.ok).toBe(false);
  if (!r.b.ok) expect(errorCode(r.b.error)).toBe('NOT_FOUND');
  expect(await db.auditLog.count({where:{entityId:r.f.id,action:'DELETE'}})).toBe(1);
 }),15000);
 it('retains the committed PATCH data and version when PATCH holds the lock first', safeTest(async()=>{
  const r=await populationRace('patch','delete'); expect(r.a.ok).toBe(true); expect(r.b.ok).toBe(true);
  expect(await db.populationRecord.findUniqueOrThrow({where:{id:r.f.id}})).toMatchObject({notes:'patched',version:4,deletedAt:expect.any(Date)});
  expect(await db.auditLog.count({where:{entityId:r.f.id,action:'DELETE'}})).toBe(1);
 }),15000);
 it('prevents PATCH and its audit when DELETE holds the lock first', safeTest(async()=>{
  const r=await populationRace('delete','patch'); expect(r.a.ok).toBe(true); expect(r.b.ok).toBe(false);
  if (!r.b.ok) expect(errorCode(r.b.error)).toBe('CONFLICT');
  expect(await db.populationRecord.findUniqueOrThrow({where:{id:r.f.id}})).toMatchObject({notes:'provenance',version:3,deletedAt:expect.any(Date)});
  expect(await db.auditLog.count({where:{requestId:r.secondContext.requestId}})).toBe(0);
 }),15000);
 it.each(['population','village'] as const)('respects village lock when %s deletion locks first', async first => {
  await safeTest(async()=>{
   const f=await fixture(), held=gate(), locked=gate(), ready=gate(); let firstPid=0, secondPid=0;
   const exists=villageRepository.exists.bind(villageRepository), writeAudit=auditRepository.create.bind(auditRepository);
   vi.spyOn(villageRepository,'exists').mockImplementation(async (id,tx)=>{
    if (!tx) return exists(id,tx);
    const pid=await backend(tx);
    if (first==='village') {secondPid=pid; ready.release(); return exists(id,tx);}
    const result=await exists(id,tx); firstPid=pid; locked.release(); await held.wait; return result;
   });
   vi.spyOn(auditRepository,'create').mockImplementation(async (input,tx)=>{
    if (first==='village' && input.entityType==='village' && tx) {firstPid=await backend(tx); locked.release(); await held.wait;}
    return writeAudit(input,tx);
   });
   // For village-second, observe its UPDATE waiting via the population lock holder PID.
   const popCtx=context(f.actorId), villageRequest=requestId();
   const runPop=():Promise<unknown>=>population.softDelete(f.id,popCtx);
   const runVillage=():Promise<unknown>=>village.remove(f.villageId,{userId:f.actorId,role:'ADMIN',requestId:villageRequest});
   const a=settled(first==='population'?runPop():runVillage()); let b:ReturnType<typeof settled> | undefined;
   try {
    await Promise.race([locked.wait,delay(4000).then(()=>{throw new Error('First village lock timeout');})]);
    b=settled(first==='population'?runVillage():runPop());
    if (first==='village') {
     await Promise.race([ready.wait,delay(4000).then(()=>{throw new Error('Second village lock timeout');})]);
     await blockedBy(secondPid,firstPid);
    } else {
     const deadline=Date.now()+4000; let found=false;
     while(Date.now()<deadline) {
      const rows=await db.$queryRaw<Array<{pid:number}>>`SELECT pid FROM pg_stat_activity WHERE ${firstPid}::integer = ANY(pg_blocking_pids(pid)) AND datname = current_database()`;
      if(rows.length){found=true; break;} await delay(30);
     }
     expect(found).toBe(true);
    }
   } finally {held.release(); await a; if(b) await b;}
   expect((await a).ok).toBe(true);
   const result=await b!;
   if(first==='village') {expect(result.ok).toBe(false); if(!result.ok) expect(errorCode(result.error)).toBe('NOT_FOUND');}
   else expect(result.ok).toBe(true);
   expect(await db.village.findUniqueOrThrow({where:{id:f.villageId}})).toMatchObject({deletedAt:expect.any(Date)});
   expect(await db.auditLog.count({where:{requestId:popCtx.requestId}})).toBe(first==='village'?0:1);
  })();
 },15000);
 it('rolls back the deletion when PostgreSQL rejects its audit foreign key', safeTest(async()=>{
  const f=await fixture(), before=await db.populationRecord.findUniqueOrThrow({where:{id:f.id}}), ctx=context(f.actorId);
  vi.spyOn(auditRepository,'create').mockImplementation(async (input,tx)=>{
   if(!tx) throw new Error('Expected transaction client');
   return tx.auditLog.create({data:{entityType:input.entityType,entityId:input.entityId,action:input.action,actorId:randomUUID(),requestId:input.requestId}});
  });
  await expect(population.softDelete(f.id,ctx)).rejects.toMatchObject({code:'P2003'});
  expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toEqual(before);
  expect(await db.auditLog.count({where:{requestId:ctx.requestId}})).toBe(0);
 }));
 it('preserves persisted provenance, releases the preferred slot and reserves the business key', safeTest(async()=>{
  const f=await fixture(), before=await db.populationRecord.findUniqueOrThrow({where:{id:f.id}}), ctx=context(f.actorId);
  await population.softDelete(f.id,ctx);
  const after=await db.populationRecord.findUniqueOrThrow({where:{id:f.id}});
  expect(after).toEqual({...before,deletedAt:expect.any(Date),updatedAt:expect.any(Date),updatedById:f.actorId,isPreferred:false});
  const audit=await db.auditLog.findFirstOrThrow({where:{requestId:ctx.requestId}});
  expect(audit).toMatchObject({entityType:'PopulationRecord',action:'DELETE',actorId:f.actorId,before:{id:f.id,villageId:f.villageId,sourceId:f.sourceId,population:100,referenceYear:2020,isPreferred:true,needsReview:true,notes:'provenance',verificationStatus:'VERIFIED',verifiedById:f.actorId,verifiedAt:'2021-01-01T00:00:00.000Z',version:3,deletedAt:null},after:{isPreferred:false,version:3,deletedAt:expect.any(String)}});
  expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.otherId}})).toMatchObject({isPreferred:false});
  await db.populationRecord.update({where:{id:f.otherId},data:{isPreferred:true}});
  expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.otherId}})).toMatchObject({isPreferred:true});
  await expect(db.populationRecord.create({data:{villageId:f.villageId,sourceId:f.sourceId,population:200,referenceYear:2020}})).rejects.toMatchObject({code:'P2002'});
 }));
 it('hides deleted records from actual list and detail HTTP routes', safeTest(async()=>{
  const f=await fixture(); await population.softDelete(f.id,context(f.actorId));
  const list=await request(app).get(`/api/v1/villages/${f.villageId}/population-records`);
   expect(list.status).toBe(200); expect(list.body.data).toEqual([]); expect(list.body.meta.total).toBe(0);
   const all=await request(app).get(`/api/v1/villages/${f.villageId}/population-records`).query({includeAll:'true'});
   expect(all.status).toBe(200); expect(all.body.data.map((item:{id:string})=>item.id)).toEqual([f.otherId]); expect(all.body.meta.total).toBe(1);
  expect((await request(app).get(`/api/v1/population-records/${f.id}`)).status).toBe(404);
 }));
 it('deletes a Population record whose source is already soft-deleted', safeTest(async()=>{
  const f=await fixture(); await db.source.update({where:{id:f.sourceId},data:{deletedAt:new Date()}});
  await population.softDelete(f.id,context(f.actorId));
  expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toMatchObject({sourceId:f.sourceId,deletedAt:expect.any(Date)});
 }));
});
