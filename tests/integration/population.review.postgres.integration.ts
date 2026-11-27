import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Prisma, PrismaClient } from '@prisma/client';
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
  (await import('../../src/app.js')).createApp();
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
 const actorId=randomUUID(), otherActor=randomUUID(), governorateId=randomUUID(), villageId=randomUUID(), sourceId=randomUUID(), otherSourceId=randomUUID(), id=randomUUID(), otherId=randomUUID();
 ids.users.add(actorId); ids.users.add(otherActor); ids.governors.add(governorateId); ids.villages.add(villageId); ids.sources.add(sourceId); ids.sources.add(otherSourceId); ids.records.add(id); ids.records.add(otherId);
 await db.user.create({data:{id:actorId,email:`${actorId}@integration.invalid`,fullName:'Integration',passwordHash:'unused',role:'ADMIN'}});
 await db.user.create({data:{id:otherActor,email:`${otherActor}@integration.invalid`,fullName:'Reviewer',passwordHash:'unused',role:'REVIEWER'}});
 await db.governorate.create({data:{id:governorateId,nameAr:`ar-${governorateId}`,nameEn:`en-${governorateId}`,code:`i-${governorateId}`}});
 await db.village.create({data:{id:villageId,governorateId,slug:`integration-${villageId}`,nameAr:'Integration'}});
 await db.source.createMany({data:[{id:sourceId,title:'first',sourceType:'BOOK'},{id:otherSourceId,title:'second',sourceType:'BOOK'}]});
 await db.populationRecord.createMany({data:[
  {id,villageId,sourceId,population:100,referenceYear:2020,referenceDate:new Date('2020-01-01T00:00:00Z'),isPreferred:true,needsReview:true,notes:'provenance',verificationStatus:'PENDING',createdById:actorId,updatedById:actorId,version:3},
  {id:otherId,villageId,sourceId:otherSourceId,population:101,referenceYear:2020,isPreferred:false,createdById:actorId}
 ]});
 return {actorId,otherActor,villageId,sourceId,otherSourceId,id,otherId};
}

type Operation = 'verify' | 'reject' | 'patch' | 'delete';
async function race(first:Operation, second:Operation) {
 const f=await fixture(), held=gate(), locked=gate(), ready=gate();
 let holder=0, waiter=0, calls=0;
 const original=populationRepository.findForDelete.bind(populationRepository);
 const updateLock=populationRepository.findForUpdate.bind(populationRepository);
 const around = <T>(fn:(id:string,tx:Prisma.TransactionClient)=>Promise<T>) => async (id:string,tx:Prisma.TransactionClient):Promise<T> => {
  const position=++calls, pid=await backend(tx);
  if(position===2){waiter=pid;ready.release();}
  const value=await fn(id,tx);
  if(position===1){holder=pid;locked.release();await held.wait;}
  return value;
 };
 vi.spyOn(populationRepository,'findForDelete').mockImplementation(around(original));
 vi.spyOn(populationRepository,'findForUpdate').mockImplementation(around(updateLock));
 const aCtx=context(f.actorId), bCtx=context(f.otherActor);
 const run=(op:Operation,ctx:ReturnType<typeof context>):Promise<unknown>=>{
  if(op==='delete') return population.softDelete(f.id,ctx);
  if(op==='patch') return population.update(f.id,{expectedVersion:3,notes:'patched'},ctx);
  return population.review(f.id,{expectedVersion:3},op==='verify'?'VERIFIED':'REJECTED',ctx);
 };
 const a=settled(run(first,aCtx)); let b:ReturnType<typeof settled> | undefined;
 try {
  await Promise.race([locked.wait,delay(4000).then(()=>{throw new Error('First lock timeout');})]);
  b=settled(run(second,bCtx));
  await Promise.race([ready.wait,delay(4000).then(()=>{throw new Error('Second lock timeout');})]);
  await blockedBy(waiter,holder);
 } finally {held.release(); await a; if(b) await b;}
 return {f,a:await a,b:await b!,aCtx,bCtx};
}
async function audits(id:string) {return db.auditLog.findMany({where:{entityId:id},orderBy:{createdAt:'asc'}});}

describe('Population review with PostgreSQL',()=>{
 it.each([['verify','verify'],['verify','reject'],['reject','verify']] as const)('serializes %s against %s using PostgreSQL locks',async(first,second)=>{
  await safeTest(async()=>{
   const r=await race(first,second); expect(r.a.ok).toBe(true); expect(r.b.ok).toBe(false);
   if(!r.b.ok) expect(errorCode(r.b.error)).toBe('CONFLICT');
   const row=await db.populationRecord.findUniqueOrThrow({where:{id:r.f.id}});
   expect(row).toMatchObject({version:4,verificationStatus:first==='verify'?'VERIFIED':'REJECTED',verifiedById:first==='verify'?r.f.actorId:null,verifiedAt:first==='verify'?expect.any(Date):null});
   expect(await audits(r.f.id)).toMatchObject([{action:first==='verify'?'VERIFY':'REJECT',actorId:r.f.actorId,requestId:r.aCtx.requestId}]);
  })();
 },15000);
 it.each([['verify','patch'],['patch','verify']] as const)('serializes %s before %s without lost updates',async(first,second)=>{
  await safeTest(async()=>{
   const r=await race(first,second); expect(r.a.ok).toBe(true); expect(r.b.ok).toBe(false);
   if(!r.b.ok) expect(errorCode(r.b.error)).toBe('CONFLICT');
   expect(await db.populationRecord.findUniqueOrThrow({where:{id:r.f.id}})).toMatchObject({version:4,verificationStatus:first==='verify'?'VERIFIED':'PENDING',notes:first==='patch'?'patched':'provenance'});
   expect(await audits(r.f.id)).toMatchObject([{action:first==='verify'?'VERIFY':'UPDATE',requestId:r.aCtx.requestId}]);
  })();
 },15000);
 it.each([['verify','delete'],['delete','verify']] as const)('serializes %s before %s with unversioned deletion',async(first,second)=>{
  await safeTest(async()=>{
   const r=await race(first,second); expect(r.a.ok).toBe(true);
   expect(r.b.ok).toBe(first==='verify');
   if(!r.b.ok) expect(errorCode(r.b.error)).toBe('NOT_FOUND');
   expect(await db.populationRecord.findUniqueOrThrow({where:{id:r.f.id}})).toMatchObject({version:first==='verify'?4:3,verificationStatus:first==='verify'?'VERIFIED':'PENDING',deletedAt:expect.any(Date),isPreferred:false});
   const rows=await audits(r.f.id); expect(rows).toHaveLength(first==='verify'?2:1);
   expect(rows.map(x=>x.action)).toEqual(first==='verify'?['VERIFY','DELETE']:['DELETE']);
  })();
 },15000);
 it.each(['review','village'] as const)('observes the parent lock when %s acts first',async first=>{
  await safeTest(async()=>{
   const f=await fixture(),held=gate(),locked=gate(),ready=gate(); let holder=0,waiter=0;
   const exists=villageRepository.exists.bind(villageRepository), writeAudit=auditRepository.create.bind(auditRepository);
   vi.spyOn(villageRepository,'exists').mockImplementation(async(id,tx)=>{
    if(!tx)return exists(id,tx);
    const pid=await backend(tx);
    if(first==='village'){waiter=pid;ready.release();return exists(id,tx);}
    const result=await exists(id,tx);holder=pid;locked.release();await held.wait;return result;
   });
   vi.spyOn(auditRepository,'create').mockImplementation(async(input,tx)=>{
    if(first==='village' && input.entityType==='village' && tx){holder=await backend(tx);locked.release();await held.wait;}
    return writeAudit(input,tx);
   });
   const reviewCtx=context(f.actorId), villageRequest=requestId();
   const runReview=():Promise<unknown>=>population.review(f.id,{expectedVersion:3},'VERIFIED',reviewCtx);
   const runVillage=():Promise<unknown>=>village.remove(f.villageId,{userId:f.actorId,role:'ADMIN',requestId:villageRequest});
   const a=settled(first==='review'?runReview():runVillage()); let b:ReturnType<typeof settled>|undefined;
   try {
    await Promise.race([locked.wait,delay(4000).then(()=>{throw new Error('First village lock timeout');})]);
    b=settled(first==='review'?runVillage():runReview());
    if(first==='village'){await Promise.race([ready.wait,delay(4000).then(()=>{throw new Error('Second village lock timeout');})]);await blockedBy(waiter,holder);}
    else {
     const deadline=Date.now()+4000; let observed=false;
     while(Date.now()<deadline){const rows=await db.$queryRaw<Array<{pid:number}>>`SELECT pid FROM pg_stat_activity WHERE ${holder}::integer = ANY(pg_blocking_pids(pid)) AND datname = current_database()`;if(rows.length){observed=true;break;}await delay(30);}
     expect(observed).toBe(true);
    }
   } finally {held.release();await a;if(b)await b;}
   expect((await a).ok).toBe(true);const result=await b!;
   if(first==='village'){expect(result.ok).toBe(false);if(!result.ok)expect(errorCode(result.error)).toBe('NOT_FOUND');}
   else expect(result.ok).toBe(true);
   expect(await db.village.findUniqueOrThrow({where:{id:f.villageId}})).toMatchObject({deletedAt:expect.any(Date)});
   expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toMatchObject({verificationStatus:first==='review'?'VERIFIED':'PENDING',version:first==='review'?4:3,deletedAt:null});
   expect(await db.auditLog.count({where:{requestId:reviewCtx.requestId}})).toBe(first==='review'?1:0);
  })();
 },15000);
 it.each([['PENDING','VERIFIED'],['PENDING','REJECTED'],['VERIFIED','REJECTED'],['REJECTED','VERIFIED'],['VERIFIED','VERIFIED'],['REJECTED','REJECTED']] as const)('%s to %s persists correct metadata, version and audit',async(status,target)=>{
  await safeTest(async()=>{
   const f=await fixture();
   await db.populationRecord.update({where:{id:f.id},data:{verificationStatus:status,verifiedById:status==='VERIFIED'?f.actorId:null,verifiedAt:status==='VERIFIED'?new Date('2021-01-01T00:00:00Z'):null}});
   const before=await db.populationRecord.findUniqueOrThrow({where:{id:f.id}}),ctx=context(f.otherActor);
   const result=await population.review(f.id,{expectedVersion:3},target,ctx);
   const after=await db.populationRecord.findUniqueOrThrow({where:{id:f.id}});
   if(status===target){
    expect(after).toEqual(before);expect(result.version).toBe(3);expect(await audits(f.id)).toHaveLength(0);
    await expect(population.review(f.id,{expectedVersion:2},target,context(f.actorId))).rejects.toMatchObject({code:'CONFLICT'});
    expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toEqual(before);expect(await audits(f.id)).toHaveLength(0);
   } else {
    expect(after).toEqual({...before,verificationStatus:target,version:4,verifiedById:target==='VERIFIED'?f.otherActor:null,verifiedAt:target==='VERIFIED'?expect.any(Date):null,updatedById:f.otherActor,updatedAt:expect.any(Date),isPreferred:target==='REJECTED'?false:before.isPreferred});
    expect(await audits(f.id)).toMatchObject([{entityType:'PopulationRecord',action:target==='VERIFIED'?'VERIFY':'REJECT',actorId:f.otherActor,requestId:ctx.requestId,before:{verificationStatus:status,version:3,needsReview:true,isPreferred:true},after:{verificationStatus:target,version:4,needsReview:true,isPreferred:target==='REJECTED'?false:true,verifiedById:target==='VERIFIED'?f.otherActor:null}}]);
    expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.otherId}})).toMatchObject({isPreferred:false});
   }
  })();
 });
 it.each(['VERIFIED','REJECTED'] as const)('rolls back %s on a real audit foreign-key failure',async target=>{
  await safeTest(async()=>{
   const f=await fixture();
   if(target==='REJECTED')await db.populationRecord.update({where:{id:f.id},data:{verificationStatus:'VERIFIED',verifiedById:f.actorId,verifiedAt:new Date('2021-01-01T00:00:00Z')}});
   const before=await db.populationRecord.findUniqueOrThrow({where:{id:f.id}}), ctx=context(f.otherActor);
   vi.spyOn(auditRepository,'create').mockImplementation(async(input,tx)=>{
    if(!tx)throw new Error('Expected transaction client');
    return tx.auditLog.create({data:{entityType:input.entityType,entityId:input.entityId,action:input.action,actorId:randomUUID(),requestId:input.requestId}});
   });
   await expect(population.review(f.id,{expectedVersion:3},target,ctx)).rejects.toMatchObject({code:'P2003'});
   expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toEqual(before);expect(await audits(f.id)).toHaveLength(0);
   await expect(db.populationRecord.update({where:{id:f.otherId},data:{isPreferred:true}})).rejects.toMatchObject({code:'P2002'});
  })();
 });
 it('clears a rejected preferred record without selecting a replacement and releases its index slot',safeTest(async()=>{
  const f=await fixture();await db.populationRecord.update({where:{id:f.id},data:{verificationStatus:'VERIFIED',verifiedById:f.actorId,verifiedAt:new Date()}});
  const otherBefore=await db.populationRecord.findUniqueOrThrow({where:{id:f.otherId}});
  await population.review(f.id,{expectedVersion:3},'REJECTED',context(f.actorId));
  expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toMatchObject({verificationStatus:'REJECTED',isPreferred:false,version:4});
  expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.otherId}})).toEqual(otherBefore);
  await db.populationRecord.update({where:{id:f.otherId},data:{isPreferred:true}});
  expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.otherId}})).toMatchObject({isPreferred:true});
 }));
 it('reviews with a deleted source and refuses inactive or missing records without audit',safeTest(async()=>{
  const f=await fixture();await db.source.update({where:{id:f.sourceId},data:{deletedAt:new Date()}});
  await population.review(f.id,{expectedVersion:3},'VERIFIED',context(f.actorId));
  expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toMatchObject({sourceId:f.sourceId,createdById:f.actorId,verificationStatus:'VERIFIED'});
  const ctx=context(f.actorId);
  await expect(population.review(randomUUID(),{expectedVersion:3},'VERIFIED',ctx)).rejects.toMatchObject({code:'NOT_FOUND'});
  await db.populationRecord.update({where:{id:f.id},data:{deletedAt:new Date()}});
  await expect(population.review(f.id,{expectedVersion:4},'REJECTED',ctx)).rejects.toMatchObject({code:'NOT_FOUND'});
  await db.village.update({where:{id:f.villageId},data:{deletedAt:new Date()}});
  await expect(population.review(f.otherId,{expectedVersion:1},'VERIFIED',ctx)).rejects.toMatchObject({code:'NOT_FOUND'});
  expect(await db.auditLog.count({where:{requestId:ctx.requestId}})).toBe(0);
 }));
});
