import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { populationService as PopulationService } from '../../src/modules/population/population.service.js';
import type { populationRepository as PopulationRepository } from '../../src/modules/population/population.repository.js';
import type { auditRepository as AuditRepository } from '../../src/modules/audit/audit.repository.js';
import type { villageService as VillageService } from '../../src/modules/villages/villages.service.js';
import type { villageRepository as VillageRepository } from '../../src/modules/villages/villages.repository.js';

let db: PrismaClient;
let population: typeof PopulationService;
let populationRepository: typeof PopulationRepository;
let auditRepository: typeof AuditRepository;
let village: typeof VillageService;
let villageRepository: typeof VillageRepository;
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
  auditRepository = (await import('../../src/modules/audit/audit.repository.js')).auditRepository;
  village = (await import('../../src/modules/villages/villages.service.js')).villageService;
  villageRepository = (await import('../../src/modules/villages/villages.repository.js')).villageRepository;
  app = (await import('../../src/app.js')).createApp();
 } catch {
  if (db) await db.$disconnect();
  throw new Error('Could not verify integration database identity or initialize test services');
 }
});

describe('Preferred selection HTTP and parent validation',()=>{
 it.each(['missing','deleted','inactive'] as const)('rejects a %s target without mutation or audit',async which=>{
  await safeTest(async()=>{
   const f=await prepare(),ctx=context(f.actorId);
   if(which==='deleted')await db.populationRecord.update({where:{id:f.otherId},data:{deletedAt:new Date()}});
   if(which==='inactive')await db.village.update({where:{id:f.villageId},data:{deletedAt:new Date()}});
   const before=await db.populationRecord.findMany({where:{id:{in:[f.id,f.otherId]}},orderBy:{id:'asc'}});
   await expect(population.selectPreferred(which==='missing'?randomUUID():f.otherId,selection(f.otherId,1,{id:f.id,version:3}),ctx)).rejects.toMatchObject({code:'NOT_FOUND'});
   expect(await db.populationRecord.findMany({where:{id:{in:[f.id,f.otherId]}},orderBy:{id:'asc'}})).toEqual(before);
   expect(await db.auditLog.count({where:{requestId:ctx.requestId}})).toBe(0);
  })();
 });
 it('returns the persisted public representation through HTTP 200',safeTest(async()=>{
  const f=await prepare(),rid=requestId(),token=jwt.sign({role:'ADMIN'},'population-integration-test-secret-at-least-32-characters',{subject:f.actorId});
  const response=await request(app).post(`/api/v1/population-records/${f.otherId}/preferred`).set('Authorization',`Bearer ${token}`).set('X-Request-Id',rid).send(selection(f.otherId,1,{id:f.id,version:3}));
  expect(response.status).toBe(200);expect(response.headers['x-request-id']).toBe(rid);
  expect(response.body.data).toMatchObject({id:f.otherId,isPreferred:true,version:2,needsReview:true});
  for(const key of ['deletedAt','createdById','updatedById','verifiedById','verifiedAt'])expect(response.body.data).not.toHaveProperty(key);
  expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.otherId}})).toMatchObject({isPreferred:true,version:2});
  expect(await db.auditLog.count({where:{requestId:rid}})).toBe(2);
 }));
 it('returns the unified HTTP 409 envelope for a real preferred-index race',async()=>{
  await safeTest(async()=>{
   const f=await prepare();await db.populationRecord.update({where:{id:f.id},data:{referenceYear:2019}});
   const held=gate(),arrived=gate(),rid=requestId(),patchCtx=context(f.actorId);
   const original=populationRepository.setPreferred.bind(populationRepository);
   vi.spyOn(populationRepository,'setPreferred').mockImplementation(async(...args)=>{arrived.release();await held.wait;return original(...args);});
   const token=jwt.sign({role:'ADMIN'},'population-integration-test-secret-at-least-32-characters',{subject:f.otherActor});
   const response=settled(Promise.resolve(request(app).post(`/api/v1/population-records/${f.otherId}/preferred`).set('Authorization',`Bearer ${token}`).set('X-Request-Id',rid).send(selection(f.otherId,1,null))));
   try{await Promise.race([arrived.wait,delay(4000).then(()=>{throw new Error('HTTP selection did not reach update');})]);await population.update(f.id,{expectedVersion:3,referenceYear:2020},patchCtx);}
   finally{held.release();}
   const result=await response;expect(result.ok).toBe(true);
   if(result.ok){expect(result.value.status).toBe(409);expect(result.value.headers['x-request-id']).toBe(rid);expect(result.value.body).toMatchObject({error:{code:'CONFLICT',requestId:rid,details:[]}});}
   expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toMatchObject({isPreferred:true,referenceYear:2020,version:4});
   expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.otherId}})).toMatchObject({isPreferred:false,version:1});
   expect(await db.auditLog.count({where:{requestId:rid}})).toBe(0);
  })();
 },15000);
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

async function fixture(order?: 'target-first'|'previous-first') {
 const actorId=randomUUID(), otherActor=randomUUID(), governorateId=randomUUID(), villageId=randomUUID(), sourceId=randomUUID(), otherSourceId=randomUUID();
 const pair=[randomUUID(),randomUUID()].sort();
 const [id,otherId]=order==='target-first'?[pair[1]!,pair[0]!]:[pair[0]!,pair[1]!];
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

async function prepare(order?: 'target-first'|'previous-first') {
 const f=await fixture(order);
 await db.populationRecord.update({where:{id:f.otherId},data:{verificationStatus:'VERIFIED',verifiedById:f.actorId,verifiedAt:new Date('2021-01-01Z'),needsReview:true}});
 return f;
}
const selection=(_id:string, version:number, previous:{id:string;version:number}|null)=>({expectedVersion:version,expectedPreferred:previous});

type RaceOperation='patch-target-year'|'patch-target-version'|'patch-old-out'|'delete-target'|'delete-old'|'reject-target'|'reject-old'|'verify-old';
async function raceOperation(operation:RaceOperation,first:'selection'|'other') {
 const f=await prepare(),held=gate(),locked=gate(),waiting=gate();let holder=0,waiter=0;
 const selectLock=populationRepository.lockPreferredRows.bind(populationRepository);
 const updateLock=populationRepository.findForUpdate.bind(populationRepository);
 const deleteLock=populationRepository.findForDelete.bind(populationRepository);
 let positions=0;
 const around=async<T>(tx:Prisma.TransactionClient,fn:()=>Promise<T>):Promise<T>=>{
  const n=++positions,pid=await backend(tx);if(n===2){waiter=pid;waiting.release();}
  const value=await fn();if(n===1){holder=pid;locked.release();await held.wait;}return value;
 };
 vi.spyOn(populationRepository,'lockPreferredRows').mockImplementation((rows,tx)=>around(tx,()=>selectLock(rows,tx)));
 vi.spyOn(populationRepository,'findForUpdate').mockImplementation((id,tx)=>around(tx,()=>updateLock(id,tx)));
 vi.spyOn(populationRepository,'findForDelete').mockImplementation((id,tx)=>around(tx,()=>deleteLock(id,tx)));
 const selectCtx=context(f.otherActor),otherCtx=context(f.actorId);
 const select=()=>population.selectPreferred(f.otherId,selection(f.otherId,1,{id:f.id,version:3}),selectCtx);
 const other=():Promise<unknown>=>{
  switch(operation){
   case 'patch-target-year':return population.update(f.otherId,{expectedVersion:1,referenceYear:2021},otherCtx);
   case 'patch-target-version':return population.update(f.otherId,{expectedVersion:1,notes:'changed'},otherCtx);
   case 'patch-old-out':return population.update(f.id,{expectedVersion:3,referenceYear:2019},otherCtx);
   case 'delete-target':return population.softDelete(f.otherId,otherCtx);
   case 'delete-old':return population.softDelete(f.id,otherCtx);
   case 'reject-target':return population.review(f.otherId,{expectedVersion:1},'REJECTED',otherCtx);
   case 'reject-old':return population.review(f.id,{expectedVersion:3},'REJECTED',otherCtx);
   case 'verify-old':return population.review(f.id,{expectedVersion:3},'VERIFIED',otherCtx);
  }
 };
 const a=settled(first==='selection'?select():other());let b:ReturnType<typeof settled>|undefined;
 try{
  await Promise.race([locked.wait,delay(4000).then(()=>{throw new Error('race holder did not lock');})]);
  b=settled(first==='selection'?other():select());
  await Promise.race([waiting.wait,delay(4000).then(()=>{throw new Error('race waiter did not start');})]);await blockedBy(waiter,holder);
 }finally{held.release();await a;if(b)await b;}
 return {f,selectCtx,otherCtx,a:await a,b:await b!};
}

describe('Preferred selection row-lock races',()=>{
 it('detects a preferred record PATCHed into an empty slot before the first slot read',async()=>{
  await safeTest(async()=>{
   const f=await prepare();await db.populationRecord.update({where:{id:f.id},data:{referenceYear:2019}});
   const held=gate(),locked=gate(),original=populationRepository.lockPreferredGroup.bind(populationRepository);
   vi.spyOn(populationRepository,'lockPreferredGroup').mockImplementation(async(v,y,tx)=>{await original(v,y,tx);locked.release();await held.wait;});
   const selectCtx=context(f.otherActor),patchCtx=context(f.actorId);
   const choosing=settled(population.selectPreferred(f.otherId,selection(f.otherId,1,null),selectCtx));
   try{await locked.wait;await population.update(f.id,{expectedVersion:3,referenceYear:2020},patchCtx);}
   finally{held.release();}
   const result=await choosing;expect(result.ok).toBe(false);if(!result.ok)expect(errorCode(result.error)).toBe('CONFLICT');
   expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toMatchObject({isPreferred:true,referenceYear:2020,version:4});
   expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.otherId}})).toMatchObject({isPreferred:false,version:1});
   expect(await db.auditLog.count({where:{requestId:selectCtx.requestId}})).toBe(0);expect(await db.auditLog.count({where:{requestId:patchCtx.requestId}})).toBe(1);
  })();
 },15000);
 it('lets the index reject a PATCH moving a preferred row into a slot claimed by a selector',async()=>{
  await safeTest(async()=>{
   const f=await prepare();await db.populationRecord.update({where:{id:f.id},data:{referenceYear:2019}});
   const held=gate(),written=gate(),waiting=gate();let holder=0,waiter=0;
   const write=populationRepository.setPreferred.bind(populationRepository),patchWrite=populationRepository.update.bind(populationRepository);
   vi.spyOn(populationRepository,'setPreferred').mockImplementation(async(...args)=>{const result=await write(...args);holder=await backend(args[4]);written.release();await held.wait;return result;});
   vi.spyOn(populationRepository,'update').mockImplementation(async(...args)=>{waiter=await backend(args[3]);waiting.release();try{return await patchWrite(...args);}catch(error){const e=error as {constructor:{name:string};code?:string;meta?:{modelName?:unknown;target?:unknown;code?:unknown}};console.log('PATCH race error metadata',JSON.stringify({class:e.constructor.name,code:e.code,modelName:e.meta?.modelName,target:e.meta?.target,sqlstate:e.meta?.code}));throw error;}});
   const selectCtx=context(f.otherActor),patchId=requestId();
   const token=jwt.sign({role:'ADMIN'},'population-integration-test-secret-at-least-32-characters',{subject:f.actorId});
   const before=await db.populationRecord.findUniqueOrThrow({where:{id:f.id}});
   const choosing=settled(population.selectPreferred(f.otherId,selection(f.otherId,1,null),selectCtx));let patching:ReturnType<typeof settled>|undefined;
   try{
    await Promise.race([written.wait,delay(4000).then(()=>{throw new Error('selection write timeout');})]);
    patching=settled(Promise.resolve(request(app).patch(`/api/v1/population-records/${f.id}`).set('Authorization',`Bearer ${token}`).set('X-Request-Id',patchId).send({expectedVersion:3,referenceYear:2020})));
    await Promise.race([waiting.wait,delay(4000).then(()=>{throw new Error('PATCH write timeout');})]);await blockedBy(waiter,holder);
   }finally{held.release();await choosing;if(patching)await patching;}
   expect((await choosing).ok).toBe(true);const result=await patching!;expect(result.ok).toBe(true);
   if(result.ok){const response=result.value as request.Response;console.log('PATCH race HTTP response',JSON.stringify({status:response.status,code:response.body.error?.code,requestId:response.body.error?.requestId}));expect(response.status).toBe(409);expect(response.headers['x-request-id']).toBe(patchId);expect(response.body.error).toMatchObject({code:'CONFLICT',requestId:patchId,details:[]});}
   expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toEqual(before);
   expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.otherId}})).toMatchObject({isPreferred:true,referenceYear:2020,version:2});
   expect(await db.auditLog.count({where:{requestId:selectCtx.requestId}})).toBe(1);expect(await db.auditLog.count({where:{requestId:patchId}})).toBe(0);
  })();
 },15000);
 it.each(['selection','village'] as const)('observes parent lock with %s first',async first=>{
  await safeTest(async()=>{
   const f=await prepare(),held=gate(),locked=gate(),waiting=gate();let holder=0,waiter=0;
   const exists=villageRepository.exists.bind(villageRepository),auditWrite=auditRepository.create.bind(auditRepository);
   vi.spyOn(villageRepository,'exists').mockImplementation(async(id,tx)=>{
    if(!tx)return exists(id,tx);const pid=await backend(tx);
    if(first==='village'){waiter=pid;waiting.release();return exists(id,tx);}
    const value=await exists(id,tx);holder=pid;locked.release();await held.wait;return value;
   });
   vi.spyOn(auditRepository,'create').mockImplementation(async(input,tx)=>{
    if(first==='village'&&input.entityType==='village'&&tx){holder=await backend(tx);locked.release();await held.wait;}
    return auditWrite(input,tx);
   });
   const ctx=context(f.otherActor),rid=requestId();
   const select=()=>population.selectPreferred(f.otherId,selection(f.otherId,1,{id:f.id,version:3}),ctx);
   const remove=()=>village.remove(f.villageId,{userId:f.actorId,role:'ADMIN',requestId:rid});
   const a=settled<unknown>(first==='selection'?select():remove());let b:ReturnType<typeof settled>|undefined;
   try{
    await Promise.race([locked.wait,delay(4000).then(()=>{throw new Error('parent holder timeout');})]);
    b=settled<unknown>(first==='selection'?remove():select());
    if(first==='village'){await waiting.wait;await blockedBy(waiter,holder);}
    else{
     const deadline=Date.now()+4000;let observed=false;
     while(Date.now()<deadline){const rows=await db.$queryRaw<Array<{pid:number}>>`SELECT pid FROM pg_stat_activity WHERE ${holder}::integer = ANY(pg_blocking_pids(pid)) AND datname=current_database()`;if(rows.length){observed=true;break;}await delay(30);}
     expect(observed).toBe(true);
    }
   }finally{held.release();await a;if(b)await b;}
   expect((await a).ok).toBe(true);const second=await b!;expect(second.ok).toBe(first==='selection');if(!second.ok)expect(errorCode(second.error)).toBe('NOT_FOUND');
   expect(await db.auditLog.count({where:{requestId:ctx.requestId}})).toBe(first==='selection'?2:0);
   await expect(population.getById(f.otherId)).rejects.toMatchObject({code:'NOT_FOUND'});
  })();
 },15000);
 it('allows a nonpreferred CREATE to commit while selection holds the group and row locks',async()=>{
  await safeTest(async()=>{
   const f=await prepare(),sourceId=randomUUID(),held=gate(),locked=gate();ids.sources.add(sourceId);
   await db.source.create({data:{id:sourceId,title:'concurrent',sourceType:'BOOK'}});
   const original=populationRepository.lockPreferredRows.bind(populationRepository);
   vi.spyOn(populationRepository,'lockPreferredRows').mockImplementation(async(rows,tx)=>{const value=await original(rows,tx);locked.release();await held.wait;return value;});
   const selectCtx=context(f.actorId),createCtx=context(f.otherActor);
   const choosing=settled(population.selectPreferred(f.otherId,selection(f.otherId,1,{id:f.id,version:3}),selectCtx));
   try{
    await locked.wait;
    const created=await population.create(f.villageId,{population:105,referenceYear:2020,sourceId,isEstimate:false},createCtx);ids.records.add(created.id);
    expect(created.isPreferred).toBe(false);expect(created.verificationStatus).toBe('PENDING');
   }finally{held.release();await choosing;}
   expect((await choosing).ok).toBe(true);
   expect(await db.populationRecord.count({where:{villageId:f.villageId,referenceYear:2020,isPreferred:true}})).toBe(1);
   expect(await db.auditLog.count({where:{requestId:selectCtx.requestId}})).toBe(2);expect(await db.auditLog.count({where:{requestId:createCtx.requestId}})).toBe(1);
  })();
 },15000);
 it.each([['target-first','same'],['target-first','different'],['previous-first','same'],['previous-first','different']] as const)(
  'serializes selectors in %s UUID ordering for %s targets',async(order,kind)=>{
   await safeTest(async()=>{
    const f=await prepare(order), thirdId=randomUUID(),sourceId=randomUUID();
    ids.records.add(thirdId);ids.sources.add(sourceId);
    await db.source.create({data:{id:sourceId,title:'third',sourceType:'BOOK'}});
    await db.populationRecord.create({data:{id:thirdId,villageId:f.villageId,sourceId,referenceYear:2020,population:102,verificationStatus:'VERIFIED',createdById:f.actorId}});
    expect(f.otherId<f.id).toBe(order==='target-first');
    const held=gate(),locked=gate(),waiting=gate(),original=populationRepository.lockPreferredGroup.bind(populationRepository);let calls=0,holder=0,waiter=0;
    vi.spyOn(populationRepository,'lockPreferredGroup').mockImplementation(async(v,y,tx)=>{
     const n=++calls,pid=await backend(tx);if(n===2){waiter=pid;waiting.release();}
     await original(v,y,tx);if(n===1){holder=pid;locked.release();await held.wait;}
    });
    const one=context(f.actorId),two=context(f.otherActor),body={id:f.id,version:3};
    const a=settled(population.selectPreferred(f.otherId,selection(f.otherId,1,body),one));let b:ReturnType<typeof settled>|undefined;
    try{
     await Promise.race([locked.wait,delay(4000).then(()=>{throw new Error('first selector did not lock');})]);
     b=settled(population.selectPreferred(kind==='same'?f.otherId:thirdId,selection(f.otherId,1,body),two));
     await Promise.race([waiting.wait,delay(4000).then(()=>{throw new Error('second selector did not start');})]);await blockedBy(waiter,holder);
    }finally{held.release();await a;if(b)await b;}
    expect((await a).ok).toBe(true);const loser=await b!;expect(loser.ok).toBe(false);if(!loser.ok)expect(errorCode(loser.error)).toBe('CONFLICT');
    expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toMatchObject({isPreferred:false,version:4});
    expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.otherId}})).toMatchObject({isPreferred:true,version:2});
    expect(await db.populationRecord.findUniqueOrThrow({where:{id:thirdId}})).toMatchObject({isPreferred:false,version:1});
    expect(await db.auditLog.count({where:{requestId:one.requestId}})).toBe(2);expect(await db.auditLog.count({where:{requestId:two.requestId}})).toBe(0);
   })();
  },15000);
 it.each([
  ['patch-target-year','selection'],['patch-target-year','other'],['patch-target-version','selection'],['patch-target-version','other'],
  ['patch-old-out','selection'],['patch-old-out','other'],['delete-target','selection'],['delete-target','other'],
  ['delete-old','selection'],['delete-old','other'],['reject-target','selection'],['reject-target','other'],
  ['reject-old','selection'],['reject-old','other'],['verify-old','selection'],['verify-old','other'],
 ] as const)('%s with %s winning observes the row lock and preserves committed state',async(operation,first)=>{
  await safeTest(async()=>{
   const r=await raceOperation(operation,first);expect(r.a.ok).toBe(true);
   const deletion=operation.startsWith('delete');
   expect(r.b.ok).toBe(first==='selection' && deletion);
   if(!r.b.ok)expect(['CONFLICT','NOT_FOUND']).toContain(errorCode(r.b.error));
   const old=await db.populationRecord.findUniqueOrThrow({where:{id:r.f.id}}),target=await db.populationRecord.findUniqueOrThrow({where:{id:r.f.otherId}});
   const selectAudits=await db.auditLog.count({where:{requestId:r.selectCtx.requestId}}),otherAudits=await db.auditLog.count({where:{requestId:r.otherCtx.requestId}});
   expect(selectAudits).toBe(first==='selection'?2:0);expect(otherAudits).toBe(first==='other'||deletion?1:0);
   if(first==='selection'){
    expect(target.version).toBe(2);expect(old.version).toBe(4);
    expect(target.isPreferred).toBe(operation!=='delete-target');expect(old.isPreferred).toBe(false);
   }else{
    expect(target.version).toBe(operation==='delete-target'?1:operation==='delete-old'?1:operation.includes('target')?2:1);
    expect(old.version).toBe(operation==='delete-old'?3:operation.includes('old')?4:3);
    expect(target.isPreferred).toBe(false);
   }
   expect(target.verificationStatus).toBe(first==='other'&&operation==='reject-target'?'REJECTED':'VERIFIED');
   expect(old.verificationStatus).toBe(first==='other'&&operation==='reject-old'?'REJECTED':first==='other'&&operation==='verify-old'?'VERIFIED':'PENDING');
   expect(target.referenceYear).toBe(first==='other'&&operation==='patch-target-year'?2021:2020);
   expect(old.referenceYear).toBe(first==='other'&&operation==='patch-old-out'?2019:2020);
   expect(target.deletedAt===null).toBe(operation!=='delete-target');
   expect(old.deletedAt===null).toBe(operation!=='delete-old');
   if(first==='other'&&operation==='reject-old')expect(old.isPreferred).toBe(false);
   expect(await db.populationRecord.count({where:{villageId:r.f.villageId,referenceYear:2020,isPreferred:true}})).toBeLessThanOrEqual(1);
  })();
 },15000);
});

describe('Population preferred selection with PostgreSQL',()=>{
 it('replaces a legacy pending preferred record, preserving provenance and auditing both changes',safeTest(async()=>{
  const f=await prepare(), ctx=context(f.otherActor);
  const before=await db.populationRecord.findMany({where:{id:{in:[f.id,f.otherId]}},orderBy:{id:'asc'}});
  const result=await population.selectPreferred(f.otherId,selection(f.otherId,1,{id:f.id,version:3}),ctx);
  expect(result).toMatchObject({id:f.otherId,isPreferred:true,version:2,needsReview:true});
  for(const field of ['deletedAt','createdById','updatedById','verifiedById','verifiedAt'])expect(result).not.toHaveProperty(field);
  const after=await db.populationRecord.findMany({where:{id:{in:[f.id,f.otherId]}},orderBy:{id:'asc'}});
  for(let i=0;i<before.length;i++){
   const old=before[i]!, current=after[i]!;
   expect(current).toEqual({...old,isPreferred:old.id===f.otherId,version:old.version+1,updatedById:f.otherActor,updatedAt:expect.any(Date)});
  }
  const audits=await db.auditLog.findMany({where:{requestId:ctx.requestId}});
  expect(audits).toHaveLength(2);
  expect(audits).toEqual(expect.arrayContaining([
   expect.objectContaining({entityId:f.id,actorId:f.otherActor,action:'UPDATE',before:expect.objectContaining({isPreferred:true,version:3}),after:expect.objectContaining({isPreferred:false,version:4})}),
   expect.objectContaining({entityId:f.otherId,actorId:f.otherActor,action:'UPDATE',before:expect.objectContaining({isPreferred:false,version:1}),after:expect.objectContaining({isPreferred:true,version:2})})]));
 }));
 it('selects a first record with a deleted source and honors the maximum-version no-op',safeTest(async()=>{
  const f=await prepare();
  await db.populationRecord.update({where:{id:f.id},data:{isPreferred:false}});
  await db.source.update({where:{id:f.otherSourceId},data:{deletedAt:new Date()}});
  const ctx=context(f.otherActor);
  await population.selectPreferred(f.otherId,selection(f.otherId,1,null),ctx);
  await db.populationRecord.update({where:{id:f.otherId},data:{version:2147483647}});
  const before=await db.populationRecord.findUniqueOrThrow({where:{id:f.otherId}}), count=await db.auditLog.count({where:{entityId:f.otherId}});
  await population.selectPreferred(f.otherId,selection(f.otherId,2147483647,{id:f.otherId,version:2147483647}),context(f.actorId));
  expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.otherId}})).toEqual(before);
  expect(await db.auditLog.count({where:{entityId:f.otherId}})).toBe(count);
 }));
 it.each(['target','previous','wrong','empty','occupied','pending','rejected','deleted-occupant'] as const)('rejects %s state without writes',async which=>{
  await safeTest(async()=>{
   const f=await prepare();let body=selection(f.otherId,1,{id:f.id,version:3});
   if(which==='target')body.expectedVersion=2;
   if(which==='previous')body.expectedPreferred={id:f.id,version:2};
   if(which==='wrong')body.expectedPreferred={id:f.otherId,version:3};
   if(which==='occupied')body.expectedPreferred=null;
   if(which==='empty')await db.populationRecord.update({where:{id:f.id},data:{isPreferred:false}});
   if(which==='pending'||which==='rejected')await db.populationRecord.update({where:{id:f.otherId},data:{verificationStatus:which==='pending'?'PENDING':'REJECTED'}});
   if(which==='deleted-occupant')await db.populationRecord.update({where:{id:f.id},data:{deletedAt:new Date()}});
   const before=await db.populationRecord.findMany({where:{id:{in:[f.id,f.otherId]}},orderBy:{id:'asc'}});
   const ctx=context(f.otherActor);
   await expect(population.selectPreferred(f.otherId,body,ctx)).rejects.toMatchObject({code:'CONFLICT'});
   expect(await db.populationRecord.findMany({where:{id:{in:[f.id,f.otherId]}},orderBy:{id:'asc'}})).toEqual(before);
   expect(await db.auditLog.count({where:{requestId:ctx.requestId}})).toBe(0);
  })();
 });
 it('captures the real partial-index conflict when PATCH fills an empty slot after the final read',async()=>{
  await safeTest(async()=>{
   const f=await prepare();await db.populationRecord.update({where:{id:f.id},data:{referenceYear:2019}});
   const held=gate(),arrived=gate();let captured:unknown;
   const original=populationRepository.setPreferred.bind(populationRepository);
   vi.spyOn(populationRepository,'setPreferred').mockImplementation(async(...args)=>{
    arrived.release();await held.wait;try{return await original(...args);}catch(error){captured=error;throw error;}
   });
   const selectionCtx=context(f.otherActor), patchCtx=context(f.actorId);
   const choosing=settled(population.selectPreferred(f.otherId,selection(f.otherId,1,null),selectionCtx));
   try {
    await Promise.race([arrived.wait,delay(4000).then(()=>{throw new Error('selection did not reach guarded write');})]);
    await population.update(f.id,{expectedVersion:3,referenceYear:2020},patchCtx);
   } finally {held.release();}
   const result=await choosing;
   if(captured && typeof captured==='object'){
    const e=captured as {constructor:{name:string};code?:string;meta?:{modelName?:unknown;target?:unknown;code?:unknown}};
    console.log('Preferred write error metadata',JSON.stringify({class:e.constructor.name,code:e.code,modelName:e.meta?.modelName,target:e.meta?.target,sqlstate:e.meta?.code}));
   }
   expect(result.ok).toBe(false);if(!result.ok)expect(errorCode(result.error)).toBe('CONFLICT');
   expect(await db.populationRecord.count({where:{villageId:f.villageId,referenceYear:2020,isPreferred:true}})).toBe(1);
   expect(await db.auditLog.count({where:{requestId:selectionCtx.requestId}})).toBe(0);
  })();
 },15000);
 it('executes preferred transactions at READ COMMITTED',safeTest(async()=>{
  const level=await populationRepository.preferredTransaction(async tx=>(await tx.$queryRaw<Array<{level:string}>>`SELECT current_setting('transaction_isolation') AS level`)[0]?.level);
  expect(level).toBe('read committed');
 }));
 it('releases the transaction advisory lock after a database-error rollback for an independent connection',safeTest(async()=>{
  const f=await prepare(),{PrismaClient}=await import('@prisma/client');
  const observer=new PrismaClient({log:[]});
  try{
   await expect(populationRepository.preferredTransaction(async tx=>{
    await populationRepository.lockPreferredGroup(f.villageId,2020,tx);
    await tx.populationRecord.update({where:{id:f.id},data:{updatedById:randomUUID()}});
   })).rejects.toMatchObject({code:'P2003'});
   const key=`qaryati:population:preferred:${f.villageId}:2020`;
   const acquired=await observer.$transaction(async tx=>(await tx.$queryRaw<Array<{acquired:boolean}>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS acquired`)[0]?.acquired);
   expect(acquired).toBe(true);
  }finally{await observer.$disconnect();}
 }));
 it('captures a real PostgreSQL advisory-lock deadlock without persisting writes',async()=>{
  await safeTest(async()=>{
   const key1=`preferred-deadlock-a-${randomUUID()}`,key2=`preferred-deadlock-b-${randomUUID()}`;
   const ready1=gate(),ready2=gate(),proceed1=gate(),proceed2=gate();let pid1=0,pid2=0;
   const run=(first:string,second:string,ready:ReturnType<typeof gate>,proceed:ReturnType<typeof gate>,setPid:(pid:number)=>void)=>
    settled(db.$transaction(async tx=>{setPid(await backend(tx));await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${first},0))::text`;ready.release();await proceed.wait;await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${second},0))::text`;},{timeout:12000}));
   const a=run(key1,key2,ready1,proceed1,pid=>{pid1=pid;}),b=run(key2,key1,ready2,proceed2,pid=>{pid2=pid;});
   try{await Promise.all([ready1.wait,ready2.wait]);proceed1.release();await blockedBy(pid1,pid2);proceed2.release();}
   finally{proceed1.release();proceed2.release();}
   const results=await Promise.all([a,b]);expect(results.filter(x=>x.ok)).toHaveLength(1);
   const failure=results.find(x=>!x.ok);if(!failure||failure.ok)throw new Error('Expected deadlock victim');
   const e=failure.error as {constructor:{name:string};code?:string;meta?:{code?:unknown}};
   console.log('PostgreSQL deadlock error metadata',JSON.stringify({class:e.constructor.name,code:e.code,sqlstate:e.meta?.code}));
   expect(['P2010','P2034']).toContain(e.code);if(e.code==='P2010')expect(e.meta?.code).toBe('40P01');
  })();
 },20000);
 it.each(['first update','second update','first audit','second audit'] as const)('rolls back after a real constraint failure at %s',async stage=>{
  await safeTest(async()=>{
   const f=await prepare(), ctx=context(f.otherActor), {PrismaClient}=await import('@prisma/client');
   const observer=new PrismaClient({log:[]});
   const originalWrite=populationRepository.setPreferred.bind(populationRepository), originalAudit=auditRepository.create.bind(auditRepository);
   let writes=0,audits=0;
   vi.spyOn(populationRepository,'setPreferred').mockImplementation(async(...args)=>{
    writes++;if(stage===`${writes===1?'first':'second'} update`){
     return args[4].populationRecord.update({where:{id:args[0]},data:{updatedById:randomUUID()}});
    }
    return originalWrite(...args);
   });
   vi.spyOn(auditRepository,'create').mockImplementation(async(input,tx)=>{
    audits++;if(stage===`${audits===1?'first':'second'} audit`)return originalAudit({...input,actorId:randomUUID()},tx);
    return originalAudit(input,tx);
   });
   try {
    const before=await observer.populationRecord.findMany({where:{id:{in:[f.id,f.otherId]}},orderBy:{id:'asc'}});
    await expect(population.selectPreferred(f.otherId,selection(f.otherId,1,{id:f.id,version:3}),ctx)).rejects.toMatchObject({code:'P2003'});
    expect(writes).toBe(stage==='first update'?1:2);
    expect(audits).toBe(stage==='first audit'?1:stage==='second audit'?2:0);
    expect(await observer.populationRecord.findMany({where:{id:{in:[f.id,f.otherId]}},orderBy:{id:'asc'}})).toEqual(before);
    expect(await observer.auditLog.count({where:{requestId:ctx.requestId}})).toBe(0);
   } finally {await observer.$disconnect();}
  })();
 });
 it('serializes selectors for an empty slot and rereads the committed slot',async()=>{
  await safeTest(async()=>{
   const f=await prepare();await db.populationRecord.update({where:{id:f.id},data:{isPreferred:false,verificationStatus:'VERIFIED'}});
   const held=gate(),locked=gate(),waiting=gate();let firstPid=0,secondPid=0,calls=0;
   const original=populationRepository.lockPreferredGroup.bind(populationRepository);
   vi.spyOn(populationRepository,'lockPreferredGroup').mockImplementation(async(v,y,tx)=>{
    const n=++calls,pid=await backend(tx);if(n===2){secondPid=pid;waiting.release();}
    await original(v,y,tx);if(n===1){firstPid=pid;locked.release();await held.wait;}
   });
   const a=settled(population.selectPreferred(f.id,selection(f.id,3,null),context(f.actorId)));let b:ReturnType<typeof settled>|undefined;
   try {await Promise.race([locked.wait,delay(4000).then(()=>{throw new Error('first selector did not lock');})]);
    b=settled(population.selectPreferred(f.otherId,selection(f.otherId,1,null),context(f.otherActor)));
    await Promise.race([waiting.wait,delay(4000).then(()=>{throw new Error('second selector did not start');})]);await blockedBy(secondPid,firstPid);
   } finally {held.release();await a;if(b)await b;}
   expect((await a).ok).toBe(true);const loser=await b!;expect(loser.ok).toBe(false);if(!loser.ok)expect(errorCode(loser.error)).toBe('CONFLICT');
   expect(await db.populationRecord.count({where:{villageId:f.villageId,referenceYear:2020,isPreferred:true}})).toBe(1);
  })();
 },15000);
 it('terminates a prolonged advisory-lock wait without committing updates or audits',async()=>{
  await safeTest(async()=>{
   const f=await prepare(),hold=gate(),acquired=gate(),started=gate();let blocker=0,waiter=0;
   const original=populationRepository.lockPreferredGroup.bind(populationRepository);
   const holding=settled(db.$transaction(async tx=>{blocker=await backend(tx);await original(f.villageId,2020,tx);acquired.release();await hold.wait;},{timeout:15000}));
   let selecting:ReturnType<typeof settled>|undefined;
   const ctx=context(f.otherActor);
   try{
    await acquired.wait;
    vi.spyOn(populationRepository,'lockPreferredGroup').mockImplementation(async(v,y,tx)=>{waiter=await backend(tx);started.release();return original(v,y,tx);});
    selecting=settled(population.selectPreferred(f.otherId,selection(f.otherId,1,{id:f.id,version:3}),ctx));
    await started.wait;await blockedBy(waiter,blocker);await delay(6000);
   }finally{hold.release();await holding;}
   const result=await selecting!;expect(result.ok).toBe(false);
   if(!result.ok)console.log('Preferred timeout error metadata',JSON.stringify({class:(result.error as Error).constructor.name,code:errorCode(result.error)}));
   expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toMatchObject({isPreferred:true,version:3});
   expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.otherId}})).toMatchObject({isPreferred:false,version:1});
   expect(await db.auditLog.count({where:{requestId:ctx.requestId}})).toBe(0);
   await populationRepository.preferredTransaction(tx=>original(f.villageId,2020,tx));
  })();
 },20000);
});
