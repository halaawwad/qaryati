import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Express } from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { populationService as PopulationService } from '../../src/modules/population/population.service.js';
import type { populationRepository as PopulationRepository } from '../../src/modules/population/population.repository.js';

let db: PrismaClient, app: Express, population: typeof PopulationService, repository: typeof PopulationRepository;
let verified=false;
const secret='population-integration-test-secret-at-least-32-characters';
const ids={users:new Set<string>(),governors:new Set<string>(),villages:new Set<string>(),sources:new Set<string>(),records:new Set<string>(),requests:new Set<string>()};
function validateTarget():void {
 if(process.env.QARYATI_POSTGRES_INTEGRATION!=='1') throw new Error('PostgreSQL integration opt-in required');
 try {const url=new URL(process.env.DATABASE_URL ?? ''); if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.port!=='55433'||url.pathname!=='/qaryati_local'||url.hash||[...url.searchParams.keys()].some(k=>k!=='schema')||(url.searchParams.has('schema')&&url.searchParams.get('schema')!=='public')) throw new Error();}
 catch {throw new Error('Integration database target is not allowed');}
}
function requestId(){const id=randomUUID();ids.requests.add(id);return id;}
function gate(){let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});return {wait,release};}
function settled<T>(promise:Promise<T>){return promise.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));}
async function deadline<T>(promise:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Synchronization timeout')),5000);})]);}finally{if(timer)clearTimeout(timer);}}
async function blockedBy(waiter:number,holder:number){const end=Date.now()+5000;while(Date.now()<end){const rows=await db.$queryRaw<Array<{blocked:boolean}>>`SELECT ${holder}::integer = ANY(pg_blocking_pids(${waiter}::integer)) AS blocked`;if(rows[0]?.blocked)return;await delay(30);}throw new Error('Expected PostgreSQL lock contention was not observed');}
async function blockedByAny(holder:number){const end=Date.now()+5000;while(Date.now()<end){const rows=await db.$queryRaw<Array<{blocked:boolean}>>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${holder}::integer = ANY(pg_blocking_pids(pid))) AS blocked`;if(rows[0]?.blocked)return;await delay(30);}throw new Error('Expected PostgreSQL lock contention was not observed');}
beforeAll(async()=>{
 validateTarget();
 try {
  const {PrismaClient}=await import('@prisma/client');db=new PrismaClient({log:[]});
  const identity=await db.$queryRaw<Array<{database:string;username:string}>>`SELECT current_database() AS database, current_user AS username`;
  if(identity.length!==1||identity[0]?.database!=='qaryati_local'||identity[0]?.username!=='qaryati_local') throw new Error();
  const marker=process.env.QARYATI_DISPOSABLE_MARKER;
  if(!marker||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marker))throw new Error('Disposable marker required');
  const safety=await db.$queryRaw<Array<{marker:string}>>`SELECT marker::text AS marker FROM qaryati_test_safety.disposable_instance LIMIT 2`;
  if(safety.length!==1||safety[0]?.marker.toLowerCase()!==marker.toLowerCase())throw new Error('Disposable marker mismatch');
  verified=true;vi.stubEnv('NODE_ENV','test');vi.stubEnv('LOG_LEVEL','silent');vi.stubEnv('RATE_LIMIT_ENABLED','false');vi.stubEnv('REDIS_URL','redis://127.0.0.1:6379');vi.stubEnv('JWT_ACCESS_SECRET',secret);
  vi.doMock('../../src/shared/db.js',()=>({prisma:db}));vi.doMock('../../src/shared/cache.js',()=>({redis:{}}));
  population=(await import('../../src/modules/population/population.service.js')).populationService;
  repository=(await import('../../src/modules/population/population.repository.js')).populationRepository;
  app=(await import('../../src/app.js')).createApp();
 } catch {if(db)await db.$disconnect();throw new Error('Could not verify integration database identity or initialize test services');}
});
afterEach(async()=>{
 vi.restoreAllMocks();if(!verified)return;
 const changes=await db.changeRequest.findMany({where:{entityType:'PopulationRecord',entityId:{in:[...ids.records]}},select:{id:true,requestedById:true}});
 if(changes.some(c=>!ids.users.has(c.requestedById)))throw new Error('Change request fixture ownership could not be established');
 const audits=await db.auditLog.findMany({where:{OR:[{entityType:'PopulationRecord',entityId:{in:[...ids.records]}},{entityType:'ChangeRequest',entityId:{in:changes.map(c=>c.id)}},{entityType:'Source',entityId:{in:[...ids.sources]}},{entityType:'village',entityId:{in:[...ids.villages]}}]},select:{id:true,actorId:true,requestId:true}});
 if(audits.some(a=>!a.actorId||!ids.users.has(a.actorId)||!a.requestId||!ids.requests.has(a.requestId)))throw new Error('Audit fixture ownership could not be established');
 await db.auditLog.deleteMany({where:{id:{in:audits.map(a=>a.id)}}});
 await db.changeRequest.deleteMany({where:{id:{in:changes.map(c=>c.id)}}});
 await db.populationRecord.deleteMany({where:{id:{in:[...ids.records]}}});
 await db.village.deleteMany({where:{id:{in:[...ids.villages]}}});await db.source.deleteMany({where:{id:{in:[...ids.sources]}}});
 await db.governorate.deleteMany({where:{id:{in:[...ids.governors]}}});await db.user.deleteMany({where:{id:{in:[...ids.users]}}});
 for(const set of Object.values(ids))set.clear();
});
afterAll(async()=>{if(db)await db.$disconnect();});
async function fixture(){
 const actorId=randomUUID(),adminId=randomUUID(),governorateId=randomUUID(),villageId=randomUUID(),otherSourceId=randomUUID(),id=randomUUID();
 let sourceId=randomUUID(); while(!/[a-f]/.test(sourceId)) sourceId=randomUUID();
 ids.users.add(actorId);ids.users.add(adminId);ids.governors.add(governorateId);ids.villages.add(villageId);ids.sources.add(sourceId);ids.sources.add(otherSourceId);ids.records.add(id);
 await db.user.createMany({data:[{id:actorId,email:`${actorId}@integration.invalid`,fullName:'Editor',passwordHash:'unused',role:'EDITOR'},{id:adminId,email:`${adminId}@integration.invalid`,fullName:'Admin',passwordHash:'unused',role:'ADMIN'}]});
 await db.governorate.create({data:{id:governorateId,nameAr:`ar-${governorateId}`,nameEn:`en-${governorateId}`,code:`i-${governorateId}`}});
 await db.village.create({data:{id:villageId,governorateId,slug:`integration-${villageId}`,nameAr:'Integration'}});
 await db.source.createMany({data:[{id:sourceId,title:'source',sourceType:'BOOK'},{id:otherSourceId,title:'other',sourceType:'BOOK'}]});
 await db.populationRecord.create({data:{id,villageId,sourceId,population:100,referenceYear:2020,referenceDate:new Date('2020-01-01T00:00:00Z'),isEstimate:true,isPreferred:true,needsReview:true,notes:'original',verificationStatus:'VERIFIED',version:3,createdById:adminId,updatedById:adminId,verifiedById:adminId,verifiedAt:new Date('2021-01-01T00:00:00Z')}});
 return {id,actorId,adminId,villageId,sourceId,otherSourceId};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function submit(f:Fixture,changes:object={population:150},version=3,rid=requestId()){
 const token=jwt.sign({role:'EDITOR'},secret,{subject:f.actorId});
 return request(app).post('/api/v1/change-requests').set('Authorization',`Bearer ${token}`).set('X-Request-Id',rid).send({entityType:'PopulationRecord',entityId:f.id,baseVersion:version,proposedChanges:changes,reason:' census '});
}
async function populationAudits(id:string){return db.auditLog.findMany({where:{entityType:'PopulationRecord',entityId:id},orderBy:{id:'asc'}});}

describe('Change Request submission with PostgreSQL',()=>{
 it('persists HTTP proposal JSON and audit without changing Population',async()=>{
  const f=await fixture(),rid=requestId(),before=await db.populationRecord.findUniqueOrThrow({where:{id:f.id}}),beforeAudits=await populationAudits(f.id);
  const proposal={referenceDate:'2024-03-01T12:30:00+02:00',notes:null,isEstimate:false};
  const res=await submit(f,proposal,3,rid);expect(res.status).toBe(201);expect(res.body.data).toMatchObject({entityType:'PopulationRecord',entityId:f.id,baseVersion:3,proposedChanges:proposal,reason:'census',status:'PENDING',requestedById:f.actorId,reviewedById:null,reviewComment:null,reviewedAt:null});
  const saved=await db.changeRequest.findUniqueOrThrow({where:{id:res.body.data.id}});expect(saved).toMatchObject({entityType:'PopulationRecord',entityId:f.id,baseVersion:3,proposedChanges:proposal,reason:'census',status:'PENDING',requestedById:f.actorId,reviewedById:null,reviewComment:null,reviewedAt:null});
  const {updatePopulationSchema}=await import('../../src/modules/population/population.schemas.js');
  expect(saved.proposedChanges).toEqual(proposal);
  if(saved.proposedChanges===null||typeof saved.proposedChanges!=='object'||Array.isArray(saved.proposedChanges))throw new Error('Stored proposal is not an object');
  expect(updatePopulationSchema.parse({expectedVersion:saved.baseVersion,...saved.proposedChanges})).toEqual({expectedVersion:3,...proposal});
  const audit=await db.auditLog.findMany({where:{entityType:'ChangeRequest',entityId:saved.id}});expect(audit).toHaveLength(1);expect(audit[0]).toMatchObject({action:'CREATE',actorId:f.actorId,requestId:rid,before:null,after:{id:saved.id,entityType:'PopulationRecord',entityId:f.id,baseVersion:3,proposedChanges:proposal,reason:'census',status:'PENDING',requestedById:f.actorId,reviewedById:null,reviewComment:null,reviewedAt:null}});
  expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toEqual(before);expect(await populationAudits(f.id)).toEqual(beforeAudits);
 });
 it('handles equivalent source UUIDs and a deleted replacement',async()=>{
  const f=await fixture(),upper=f.sourceId.toUpperCase();expect(upper).not.toBe(f.sourceId);
  expect((await submit(f,{sourceId:upper})).status).toBe(400);
  await db.source.update({where:{id:f.sourceId},data:{deletedAt:new Date()}});
  expect((await submit(f,{sourceId:upper})).status).toBe(400);
  const res=await submit(f,{sourceId:upper,population:151});expect(res.status).toBe(201);expect((await db.changeRequest.findUniqueOrThrow({where:{id:res.body.data.id}})).proposedChanges).toEqual({sourceId:f.sourceId,population:151});
  await db.source.update({where:{id:f.otherSourceId},data:{deletedAt:new Date()}});
  expect((await submit(f,{sourceId:f.otherSourceId})).status).toBe(404);
 });
 it('rejects missing, deleted, inactive, ineligible, stale and exhausted targets',async()=>{
  const f=await fixture();const missing={...f,id:randomUUID()};expect((await submit(missing)).status).toBe(404);
  await db.populationRecord.update({where:{id:f.id},data:{deletedAt:new Date()}});expect((await submit(f)).status).toBe(404);
  await db.populationRecord.update({where:{id:f.id},data:{deletedAt:null}});await db.village.update({where:{id:f.villageId},data:{deletedAt:new Date()}});expect((await submit(f)).status).toBe(404);
  await db.village.update({where:{id:f.villageId},data:{deletedAt:null}});
  for(const status of ['PENDING','REJECTED'] as const){await db.populationRecord.update({where:{id:f.id},data:{verificationStatus:status}});expect((await submit(f)).status).toBe(409);}
  await db.populationRecord.update({where:{id:f.id},data:{verificationStatus:'VERIFIED'}});expect((await submit(f,{population:150},2)).status).toBe(409);
  await db.populationRecord.update({where:{id:f.id},data:{version:2147483647}});expect((await submit(f,{population:150},2147483647)).status).toBe(409);
  expect(await db.changeRequest.count({where:{entityId:f.id}})).toBe(0);
 });
 it('allows multiple pending requests',async()=>{const f=await fixture();expect((await submit(f)).status).toBe(201);expect((await submit(f)).status).toBe(201);expect(await db.changeRequest.count({where:{entityId:f.id,status:'PENDING'}})).toBe(2);});
 it('rolls back request creation on a real audit constraint failure',async()=>{
  const f=await fixture(),rid=requestId(),before=await db.populationRecord.findUniqueOrThrow({where:{id:f.id}}),beforeAudits=await populationAudits(f.id);
  await db.$executeRaw`ALTER TABLE audit_logs ADD CONSTRAINT change_request_submit_test_reject CHECK (entity_type <> 'ChangeRequest') NOT VALID`;
  try {expect((await submit(f,{population:150},3,rid)).status).toBe(500);expect(await db.changeRequest.count({where:{entityId:f.id}})).toBe(0);expect(await db.auditLog.count({where:{requestId:rid}})).toBe(0);expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toEqual(before);expect(await populationAudits(f.id)).toEqual(beforeAudits);}
  finally {await db.$executeRaw`ALTER TABLE audit_logs DROP CONSTRAINT change_request_submit_test_reject`;}
 });
});

describe('Submission and Population row-lock races',()=>{
 it('serializes simultaneous submissions while preserving both requests and audits',async()=>{
  const f=await fixture(),held=gate(),locked=gate(),waiting=gate(),original=repository.findForUpdate.bind(repository);let holder=0,waiter=0,calls=0;
  vi.spyOn(repository,'findForUpdate').mockImplementation(async(id,client)=>{
   const position=++calls,pid=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
   if(position===2){waiter=pid;waiting.release();}const row=await original(id,client);
   if(position===1){holder=pid;locked.release();await deadline(held.wait);}return row;
  });
  const firstId=requestId(),secondId=requestId(),first=settled(Promise.resolve(submit(f,{population:150},3,firstId)));let second:ReturnType<typeof settled<Awaited<ReturnType<typeof submit>>>>|undefined;
  try{await deadline(locked.wait);second=settled(Promise.resolve(submit(f,{population:160},3,secondId)));await deadline(waiting.wait);await blockedBy(waiter,holder);}
  finally{held.release();await first;if(second)await second;}
  const a=await first,b=await second!;expect(a.ok).toBe(true);expect(b.ok).toBe(true);
  if(a.ok&&b.ok){expect(a.value.status).toBe(201);expect(b.value.status).toBe(201);expect(a.value.body.data.id).not.toBe(b.value.body.data.id);}
  expect(await db.changeRequest.count({where:{entityId:f.id,status:'PENDING',baseVersion:3}})).toBe(2);
  for(const rid of [firstId,secondId])expect(await db.auditLog.count({where:{requestId:rid,entityType:'ChangeRequest',action:'CREATE'}})).toBe(1);
  expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toMatchObject({version:3,verificationStatus:'VERIFIED'});
 },15000);
 it.each(['submission','selection'] as const)('rechecks the version when %s acquires the Population lock first',async firstOperation=>{
  const f=await fixture(),other=randomUUID(),held=gate(),locked=gate(),waiting=gate();ids.records.add(other);
  await db.populationRecord.create({data:{id:other,villageId:f.villageId,sourceId:f.otherSourceId,population:120,referenceYear:2020,verificationStatus:'VERIFIED',version:1}});
  const getUpdate=repository.findForUpdate.bind(repository),getRows=repository.lockPreferredRows.bind(repository);let holder=0,waiter=0;
  vi.spyOn(repository,'findForUpdate').mockImplementation(async(id,client)=>{
   const pid=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
   if(firstOperation==='selection'){waiter=pid;waiting.release();}const result=await getUpdate(id,client);
   if(firstOperation==='submission'){holder=pid;locked.release();await deadline(held.wait);}return result;
  });
  vi.spyOn(repository,'lockPreferredRows').mockImplementation(async(idsToLock,client)=>{
   const pid=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
   if(firstOperation==='submission'){waiter=pid;waiting.release();}const result=await getRows(idsToLock,client);
   if(firstOperation==='selection'){holder=pid;locked.release();await deadline(held.wait);}return result;
  });
  const submitId=requestId(),selectId=requestId(),ctx={actorId:f.adminId,role:'ADMIN' as const,requestId:selectId};
  const submitAction=()=>settled(Promise.resolve(submit(f,{population:150},3,submitId)));
  const selectAction=()=>settled(population.selectPreferred(other,{expectedVersion:1,expectedPreferred:{id:f.id,version:3}},ctx));
  const first=firstOperation==='submission'?submitAction():selectAction();let second:ReturnType<typeof submitAction>|ReturnType<typeof selectAction>|undefined;
  try{await deadline(locked.wait);second=firstOperation==='submission'?selectAction():submitAction();await deadline(waiting.wait);await blockedBy(waiter,holder);}
  finally{held.release();await first;if(second)await second;}
  const a=await first,b=await second!;expect(a.ok).toBe(true);expect(b.ok).toBe(true);
  const response=firstOperation==='submission'?a:b;
  if(response.ok)expect((response.value as Awaited<ReturnType<typeof submit>>).status).toBe(firstOperation==='submission'?201:409);
  expect(await db.changeRequest.count({where:{entityId:f.id}})).toBe(firstOperation==='submission'?1:0);
  expect(await db.auditLog.count({where:{requestId:submitId,entityType:'ChangeRequest'}})).toBe(firstOperation==='submission'?1:0);
  expect(await db.auditLog.count({where:{requestId:selectId,entityType:'PopulationRecord',action:'UPDATE'}})).toBe(2);
  expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toMatchObject({version:4,isPreferred:false});
  expect(await db.populationRecord.findUniqueOrThrow({where:{id:other}})).toMatchObject({version:2,isPreferred:true});
 },15000);
 it.each(['patch','delete','reject'] as const)('holds the submission lock against %s and commits both in order',async operation=>{
  const f=await fixture(),held=gate(),locked=gate(),waiting=gate();let holder=0,waiter=0,calls=0;
  const findUpdate=repository.findForUpdate.bind(repository),findDelete=repository.findForDelete.bind(repository);
  const wrap=<T>(fn:(id:string,client:Prisma.TransactionClient)=>Promise<T>)=>async(id:string,client:Prisma.TransactionClient):Promise<T>=>{
   const position=++calls;const pid=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
   if(position===2){waiter=pid;waiting.release();}const result=await fn(id,client);
   if(position===1){holder=pid;locked.release();await deadline(held.wait);}return result;
  };
  vi.spyOn(repository,'findForUpdate').mockImplementation(wrap(findUpdate));vi.spyOn(repository,'findForDelete').mockImplementation(wrap(findDelete));
  const submitRid=requestId(),mutationRid=requestId(),ctx={actorId:f.adminId,role:'ADMIN' as const,requestId:mutationRid};
  const first=settled(Promise.resolve(submit(f,{population:150},3,submitRid)));let second:ReturnType<typeof settled>|undefined;
  try {
   await deadline(locked.wait);
   const mutation=operation==='patch'?population.update(f.id,{expectedVersion:3,notes:'changed'},ctx):operation==='delete'?population.softDelete(f.id,ctx):population.review(f.id,{expectedVersion:3},'REJECTED',ctx);
   second=settled<unknown>(mutation);await deadline(waiting.wait);await blockedBy(waiter,holder);
  } finally {held.release();await first;if(second)await second;}
  const submitted=await first,mutated=await second!;expect(submitted.ok).toBe(true);if(submitted.ok)expect(submitted.value.status).toBe(201);expect(mutated.ok).toBe(true);
  expect(await db.changeRequest.count({where:{entityId:f.id,status:'PENDING',baseVersion:3}})).toBe(1);
  expect(await db.auditLog.count({where:{requestId:submitRid,entityType:'ChangeRequest',action:'CREATE'}})).toBe(1);
  expect(await db.auditLog.count({where:{requestId:mutationRid,entityType:'PopulationRecord'}})).toBe(1);
 });
 it.each(['patch','delete','reject'] as const)('rechecks the target after %s commits before submission',async operation=>{
  const f=await fixture(),held=gate(),locked=gate(),waiting=gate();let holder=0,waiter=0,calls=0;
  const findUpdate=repository.findForUpdate.bind(repository),findDelete=repository.findForDelete.bind(repository);
  const wrap=<T>(fn:(id:string,client:Prisma.TransactionClient)=>Promise<T>)=>async(id:string,client:Prisma.TransactionClient):Promise<T>=>{
   const position=++calls;const pid=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
   if(position===2){waiter=pid;waiting.release();}const result=await fn(id,client);
   if(position===1){holder=pid;locked.release();await deadline(held.wait);}return result;
  };
  vi.spyOn(repository,'findForUpdate').mockImplementation(wrap(findUpdate));vi.spyOn(repository,'findForDelete').mockImplementation(wrap(findDelete));
  const mutationRid=requestId(),submitRid=requestId(),ctx={actorId:f.adminId,role:'ADMIN' as const,requestId:mutationRid};
  const mutation=operation==='patch'?population.update(f.id,{expectedVersion:3,notes:'changed'},ctx):operation==='delete'?population.softDelete(f.id,ctx):population.review(f.id,{expectedVersion:3},'REJECTED',ctx);
  const first=settled<unknown>(mutation);let second:ReturnType<typeof settled<Awaited<ReturnType<typeof submit>>>>|undefined;
  try {await deadline(locked.wait);second=settled(Promise.resolve(submit(f,{population:150},3,submitRid)));await deadline(waiting.wait);await blockedBy(waiter,holder);}
  finally {held.release();await first;if(second)await second;}
  expect((await first).ok).toBe(true);const submitted=await second!;expect(submitted.ok).toBe(true);if(submitted.ok)expect(submitted.value.status).toBe(operation==='delete'?404:409);
  expect(await db.changeRequest.count({where:{entityId:f.id}})).toBe(0);expect(await db.auditLog.count({where:{requestId:submitRid}})).toBe(0);
  expect(await db.auditLog.count({where:{requestId:mutationRid,entityType:'PopulationRecord'}})).toBe(1);
 });
});

describe('Submission and parent deletion races',()=>{
 it.each([['village','submission'],['village','deletion'],['source','submission'],['source','deletion']] as const)('%s deletion with %s first',async(kind,firstOperation)=>{
  const f=await fixture(),held=gate(),locked=gate();let holder=0;
  const {villageService}=await import('../../src/modules/villages/villages.service.js');
  const {sourceRepository}=await import('../../src/modules/sources/sources.repository.js');
  const {sourceService}=await import('../../src/modules/sources/sources.service.js');
  const audit=await import('../../src/modules/audit/audit.service.js');
  const originalAudit=audit.recordAudit.bind(audit),ensure=villageService.ensureExists.bind(villageService),findSource=sourceRepository.findById.bind(sourceRepository);
  vi.spyOn(audit,'recordAudit').mockImplementation(async(input,client)=>{
   const result=await originalAudit(input,client);
   if(firstOperation==='deletion' && client && input.requestId===deleteId){holder=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;locked.release();await deadline(held.wait);}
   return result;
  });
  vi.spyOn(villageService,'ensureExists').mockImplementation(async(id,client)=>{
   await ensure(id,client);
   if(kind==='village' && firstOperation==='submission' && client && id===f.villageId){holder=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;locked.release();await deadline(held.wait);}
  });
  vi.spyOn(sourceRepository,'findById').mockImplementation(async(id,client)=>{
   const result=await findSource(id,client);
   if(kind==='source' && firstOperation==='submission' && client && id===f.otherSourceId){holder=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;locked.release();await deadline(held.wait);}
   return result;
  });
  const submitId=requestId(),deleteId=requestId();
  const submitAction=()=>settled(Promise.resolve(submit(f,kind==='source'?{sourceId:f.otherSourceId}:{population:150},3,submitId)));
  const deleteAction=()=>settled<unknown>(kind==='source'?sourceService.softDelete(f.otherSourceId,{expectedVersion:1},{actorId:f.adminId,role:'ADMIN',requestId:deleteId}):villageService.remove(f.villageId,{userId:f.adminId,role:'ADMIN',requestId:deleteId}));
  const first=firstOperation==='submission'?submitAction():deleteAction();let second:ReturnType<typeof submitAction>|ReturnType<typeof deleteAction>|undefined;
  try{await deadline(locked.wait);second=firstOperation==='submission'?deleteAction():submitAction();await blockedByAny(holder);}
  finally{held.release();await first;if(second)await second;}
  const a=await first,b=await second!;expect(a.ok).toBe(true);expect(b.ok).toBe(true);
  const submitted=firstOperation==='submission'?a:b;
  if(submitted.ok)expect((submitted.value as Awaited<ReturnType<typeof submit>>).status).toBe(firstOperation==='submission'?201:404);
  expect(await db.changeRequest.count({where:{entityId:f.id}})).toBe(firstOperation==='submission'?1:0);
  expect(await db.auditLog.count({where:{requestId:submitId,entityType:'ChangeRequest'}})).toBe(firstOperation==='submission'?1:0);
  expect(await db.auditLog.count({where:{requestId:deleteId,action:'DELETE'}})).toBe(1);
 },15000);
});

function approve(f:Fixture,id:string,rid=requestId()) {
 const token=jwt.sign({role:'ADMIN'},secret,{subject:f.adminId});
 return request(app).post(`/api/v1/change-requests/${id}/approve`).set('Authorization',`Bearer ${token}`).set('X-Request-Id',rid).send({reviewComment:' accepted '});
}

describe('Change Request approval with PostgreSQL',()=>{
 it('persists the update, metadata, and both audit snapshots; other proposals remain pending and stale',async()=>{
  const f=await fixture(),first=await submit(f,{population:151}),second=await submit(f,{notes:'another'});
  expect(first.status).toBe(201);expect(second.status).toBe(201);
  const before=await db.populationRecord.findUniqueOrThrow({where:{id:f.id}}),rid=requestId();
  const res=await approve(f,first.body.data.id,rid);expect(res.status).toBe(200);expect(res.body.data).toMatchObject({status:'APPROVED',reviewedById:f.adminId,reviewComment:'accepted'});
  const after=await db.populationRecord.findUniqueOrThrow({where:{id:f.id}});
  expect(after).toMatchObject({population:151,version:4,verificationStatus:'VERIFIED',verifiedById:before.verifiedById,verifiedAt:before.verifiedAt,isPreferred:true,needsReview:true,updatedById:f.adminId});
  const audits=await db.auditLog.findMany({where:{requestId:rid},orderBy:{entityType:'asc'}});expect(audits).toHaveLength(2);
  expect(audits[0]).toMatchObject({entityType:'ChangeRequest',action:'APPROVE',actorId:f.adminId,before:{status:'PENDING'},after:{status:'APPROVED',reviewedById:f.adminId}});
  expect(audits[1]).toMatchObject({entityType:'PopulationRecord',action:'UPDATE',actorId:f.adminId,before:{population:100,version:3},after:{population:151,version:4}});
  const staleId=requestId();expect((await approve(f,second.body.data.id,staleId)).status).toBe(409);expect((await db.changeRequest.findUniqueOrThrow({where:{id:second.body.data.id}})).status).toBe('PENDING');expect(await db.auditLog.count({where:{requestId:staleId}})).toBe(0);
  const token=jwt.sign({role:'ADMIN'},secret,{subject:f.adminId});const historical=await request(app).get(`/api/v1/change-requests/${second.body.data.id}`).set('Authorization',`Bearer ${token}`);expect(historical.status).toBe(200);expect(historical.body.data.status).toBe('PENDING');
 });
 it.each(['PopulationRecord','ChangeRequest'] as const)('rolls back both changes and audits when the %s audit fails',async entity=>{
  const f=await fixture(),submitted=await submit(f,{notes:'changed'}),before=await db.populationRecord.findUniqueOrThrow({where:{id:f.id}}),rid=requestId();
  const {auditRepository}=await import('../../src/modules/audit/audit.repository.js');const original=auditRepository.create.bind(auditRepository);
  vi.spyOn(auditRepository,'create').mockImplementation(async(input,client)=>{if(input.entityType===entity)throw new Error('injected audit failure');return original(input,client);});
  expect((await approve(f,submitted.body.data.id,rid)).status).toBe(500);
  expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toEqual(before);expect((await db.changeRequest.findUniqueOrThrow({where:{id:submitted.body.data.id}})).status).toBe('PENDING');expect(await db.auditLog.count({where:{requestId:rid}})).toBe(0);
 });
 it('rolls back the Population update when the guarded request transition fails',async()=>{
  const f=await fixture(),submitted=await submit(f,{notes:'changed'}),before=await db.populationRecord.findUniqueOrThrow({where:{id:f.id}}),rid=requestId();
  const {changeRequestsRepository}=await import('../../src/modules/change-requests/change-requests.repository.js');vi.spyOn(changeRequestsRepository,'approve').mockRejectedValueOnce(new Error('injected guarded transition failure'));
  expect((await approve(f,submitted.body.data.id,rid)).status).toBe(500);expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toEqual(before);expect((await db.changeRequest.findUniqueOrThrow({where:{id:submitted.body.data.id}})).status).toBe('PENDING');expect(await db.auditLog.count({where:{requestId:rid}})).toBe(0);
 });
 it('serializes two approvals on the request row',async()=>{
  const f=await fixture(),submitted=await submit(f,{notes:'changed'}),id=submitted.body.data.id;
  const {changeRequestsRepository}=await import('../../src/modules/change-requests/change-requests.repository.js');const original=changeRequestsRepository.lockById.bind(changeRequestsRepository),held=gate(),locked=gate(),waiting=gate();let calls=0,holder=0,waiter=0;
  vi.spyOn(changeRequestsRepository,'lockById').mockImplementation(async(requestId,client)=>{const n=++calls,pid=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;if(n===2){waiter=pid;waiting.release();}const result=await original(requestId,client);if(n===1){holder=pid;locked.release();await deadline(held.wait);}return result;});
  const firstId=requestId(),secondId=requestId(),first=settled(Promise.resolve(approve(f,id,firstId)));let second:typeof first|undefined;
  try{await deadline(locked.wait);second=settled(Promise.resolve(approve(f,id,secondId)));await deadline(waiting.wait);await blockedBy(waiter,holder);}finally{held.release();await first;if(second)await second;}
  const a=await first,b=await second!;expect(a.ok&&a.value.status).toBe(200);expect(b.ok&&b.value.status).toBe(409);expect(await db.auditLog.count({where:{requestId:firstId}})).toBe(2);expect(await db.auditLog.count({where:{requestId:secondId}})).toBe(0);
 },15000);
 it('serializes competing proposals against the same target and leaves the loser pending',async()=>{
  const f=await fixture(),one=await submit(f,{notes:'first'}),two=await submit(f,{notes:'second'});
  const held=gate(),locked=gate(),waiting=gate(),original=repository.findForDelete.bind(repository);let calls=0,holder=0,waiter=0;
  vi.spyOn(repository,'findForDelete').mockImplementation(async(id,client)=>{const n=++calls,pid=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;if(n===2){waiter=pid;waiting.release();}const result=await original(id,client);if(n===1){holder=pid;locked.release();await deadline(held.wait);}return result;});
  const firstId=requestId(),secondId=requestId(),first=settled(Promise.resolve(approve(f,one.body.data.id,firstId)));let second:typeof first|undefined;
  try{await deadline(locked.wait);second=settled(Promise.resolve(approve(f,two.body.data.id,secondId)));await deadline(waiting.wait);await blockedBy(waiter,holder);}finally{held.release();await first;if(second)await second;}
  const a=await first,b=await second!;expect(a.ok&&a.value.status).toBe(200);expect(b.ok&&b.value.status).toBe(409);expect((await db.changeRequest.findUniqueOrThrow({where:{id:two.body.data.id}})).status).toBe('PENDING');expect(await db.auditLog.count({where:{requestId:secondId}})).toBe(0);
 },15000);
 it('serializes approval against rejection of the same request',async()=>{
  const f=await fixture(),submitted=await submit(f,{notes:'changed'}),id=submitted.body.data.id,held=gate(),locked=gate(),waiting=gate();
  const {changeRequestsRepository}=await import('../../src/modules/change-requests/change-requests.repository.js');const original=changeRequestsRepository.lockById.bind(changeRequestsRepository);let calls=0,holder=0,waiter=0;
  vi.spyOn(changeRequestsRepository,'lockById').mockImplementation(async(requestId,client)=>{const n=++calls,pid=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;if(n===2){waiter=pid;waiting.release();}const result=await original(requestId,client);if(n===1){holder=pid;locked.release();await deadline(held.wait);}return result;});
  const firstId=requestId(),secondId=requestId(),first=settled(Promise.resolve(approve(f,id,firstId)));let second:typeof first|undefined;
  try{await deadline(locked.wait);const token=jwt.sign({role:'ADMIN'},secret,{subject:f.adminId});second=settled(Promise.resolve(request(app).post(`/api/v1/change-requests/${id}/reject`).set('Authorization',`Bearer ${token}`).set('X-Request-Id',secondId).send({reviewComment:'reject'})));await deadline(waiting.wait);await blockedBy(waiter,holder);}finally{held.release();await first;if(second)await second;}
  const a=await first,b=await second!;expect(a.ok&&a.value.status).toBe(200);expect(b.ok&&b.value.status).toBe(409);expect(await db.auditLog.count({where:{requestId:firstId}})).toBe(2);expect(await db.auditLog.count({where:{requestId:secondId}})).toBe(0);
 },15000);
 it('leaves the Population unchanged when rejection wins the request lock',async()=>{
  const f=await fixture(),submitted=await submit(f,{notes:'changed'}),id=submitted.body.data.id,held=gate(),locked=gate(),waiting=gate(),before=await db.populationRecord.findUniqueOrThrow({where:{id:f.id}});
  const {changeRequestsRepository}=await import('../../src/modules/change-requests/change-requests.repository.js');const original=changeRequestsRepository.lockById.bind(changeRequestsRepository);let calls=0,holder=0,waiter=0;
  vi.spyOn(changeRequestsRepository,'lockById').mockImplementation(async(requestId,client)=>{const n=++calls,pid=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;if(n===2){waiter=pid;waiting.release();}const result=await original(requestId,client);if(n===1){holder=pid;locked.release();await deadline(held.wait);}return result;});
  const rejectId=requestId(),approveId=requestId(),token=jwt.sign({role:'ADMIN'},secret,{subject:f.adminId});const first=settled(Promise.resolve(request(app).post(`/api/v1/change-requests/${id}/reject`).set('Authorization',`Bearer ${token}`).set('X-Request-Id',rejectId).send({reviewComment:'reject'})));let second:typeof first|undefined;
  try{await deadline(locked.wait);second=settled(Promise.resolve(approve(f,id,approveId)));await deadline(waiting.wait);await blockedBy(waiter,holder);}finally{held.release();await first;if(second)await second;}
  const a=await first,b=await second!;expect(a.ok&&a.value.status).toBe(200);expect(b.ok&&b.value.status).toBe(409);expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toEqual(before);expect((await db.changeRequest.findUniqueOrThrow({where:{id}})).status).toBe('REJECTED');expect(await db.auditLog.count({where:{requestId:approveId}})).toBe(0);
 },15000);
 it.each(['patch','delete','reject','verify'] as const)('serializes approval before Population %s',async operation=>{
  const f=await fixture(),submitted=await submit(f,{notes:'approved'}),held=gate(),locked=gate();let holder=0;
  const original=repository.findForDelete.bind(repository);let paused=false;
  vi.spyOn(repository,'findForDelete').mockImplementation(async(id,client)=>{const result=await original(id,client);if(!paused){paused=true;holder=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;locked.release();await deadline(held.wait);}return result;});
  const firstId=requestId(),secondId=requestId(),context={actorId:f.adminId,role:'ADMIN' as const,requestId:secondId};
  const first=settled(Promise.resolve(approve(f,submitted.body.data.id,firstId)));let second:ReturnType<typeof settled<unknown>>|undefined;
  try{await deadline(locked.wait);second=settled<unknown>(operation==='patch'?population.update(f.id,{expectedVersion:3,notes:'direct'},context):operation==='delete'?population.softDelete(f.id,context):population.review(f.id,{expectedVersion:3},operation==='verify'?'VERIFIED':'REJECTED',context));await blockedByAny(holder);}finally{held.release();await first;if(second)await second;}
  const a=await first,b=await second!;expect(a.ok&&a.value.status).toBe(200);if(operation==='delete')expect(b.ok).toBe(true);else expect(b.ok).toBe(false);expect((await db.changeRequest.findUniqueOrThrow({where:{id:submitted.body.data.id}})).status).toBe('APPROVED');
 },15000);
 it.each(['patch','delete','reject','verify'] as const)('revalidates approval after Population %s wins the row lock',async operation=>{
  const f=await fixture(),submitted=await submit(f,{notes:'approved'}),held=gate(),locked=gate();let holder=0,paused=false;
  const originalDelete=repository.findForDelete.bind(repository),originalUpdate=repository.findForUpdate.bind(repository);
  vi.spyOn(repository,'findForDelete').mockImplementation(async(id,client)=>{const result=await originalDelete(id,client);if(operation!=='patch'&&!paused){paused=true;holder=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;locked.release();await deadline(held.wait);}return result;});
  vi.spyOn(repository,'findForUpdate').mockImplementation(async(id,client)=>{const result=await originalUpdate(id,client);if(operation==='patch'&&!paused){paused=true;holder=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;locked.release();await deadline(held.wait);}return result;});
  const firstId=requestId(),secondId=requestId(),context={actorId:f.adminId,role:'ADMIN' as const,requestId:firstId};
  const first=settled<unknown>(operation==='patch'?population.update(f.id,{expectedVersion:3,notes:'direct'},context):operation==='delete'?population.softDelete(f.id,context):population.review(f.id,{expectedVersion:3},operation==='verify'?'VERIFIED':'REJECTED',context));let second:ReturnType<typeof settled<Awaited<ReturnType<typeof approve>>>>|undefined;
  try{await deadline(locked.wait);second=settled(Promise.resolve(approve(f,submitted.body.data.id,secondId)));await blockedByAny(holder);}finally{held.release();await first;if(second)await second;}
  const a=await first,b=await second!;expect(a.ok).toBe(true);expect(b.ok&&b.value.status).toBe(operation==='delete'?404:operation==='verify'?200:409);expect((await db.changeRequest.findUniqueOrThrow({where:{id:submitted.body.data.id}})).status).toBe(operation==='verify'?'APPROVED':'PENDING');expect(await db.auditLog.count({where:{requestId:secondId}})).toBe(operation==='verify'?2:0);
 },15000);
 it.each([['village','approval'],['village','deletion'],['source','approval'],['source','deletion']] as const)('serializes approval and %s deletion with %s first',async(kind,firstOperation)=>{
  const f=await fixture(),submitted=await submit(f,kind==='source'?{sourceId:f.otherSourceId}:{notes:'approved'}),held=gate(),locked=gate();let holder=0;
  const {villageService}=await import('../../src/modules/villages/villages.service.js');const {sourceRepository}=await import('../../src/modules/sources/sources.repository.js');const {sourceService}=await import('../../src/modules/sources/sources.service.js');const audit=await import('../../src/modules/audit/audit.service.js');
  const originalAudit=audit.recordAudit.bind(audit),ensure=villageService.ensureExists.bind(villageService),findSource=sourceRepository.findById.bind(sourceRepository);const approveId=requestId(),deleteId=requestId();
  vi.spyOn(audit,'recordAudit').mockImplementation(async(input,client)=>{const result=await originalAudit(input,client);if(firstOperation==='deletion'&&client&&input.requestId===deleteId){holder=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;locked.release();await deadline(held.wait);}return result;});
  vi.spyOn(villageService,'ensureExists').mockImplementation(async(id,client)=>{await ensure(id,client);if(kind==='village'&&firstOperation==='approval'&&client&&id===f.villageId){holder=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;locked.release();await deadline(held.wait);}});
  vi.spyOn(sourceRepository,'findById').mockImplementation(async(id,client)=>{const result=await findSource(id,client);if(kind==='source'&&firstOperation==='approval'&&client&&id===f.otherSourceId){holder=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;locked.release();await deadline(held.wait);}return result;});
  const approveAction=()=>settled(Promise.resolve(approve(f,submitted.body.data.id,approveId)));
  const deleteAction=()=>settled<unknown>(kind==='source'?sourceService.softDelete(f.otherSourceId,{expectedVersion:1},{actorId:f.adminId,role:'ADMIN',requestId:deleteId}):villageService.remove(f.villageId,{userId:f.adminId,role:'ADMIN',requestId:deleteId}));
  const first=firstOperation==='approval'?approveAction():deleteAction();let second:ReturnType<typeof approveAction>|ReturnType<typeof deleteAction>|undefined;
  try{await deadline(locked.wait);second=firstOperation==='approval'?deleteAction():approveAction();await blockedByAny(holder);}finally{held.release();await first;if(second)await second;}
  const a=await first,b=await second!;expect(a.ok).toBe(true);expect(b.ok).toBe(true);const approved=firstOperation==='approval'?a:b;if(approved.ok)expect((approved.value as Awaited<ReturnType<typeof approve>>).status).toBe(firstOperation==='approval'?200:404);
  expect((await db.changeRequest.findUniqueOrThrow({where:{id:submitted.body.data.id}})).status).toBe(firstOperation==='approval'?'APPROVED':'PENDING');expect(await db.auditLog.count({where:{requestId:approveId}})).toBe(firstOperation==='approval'?2:0);
 },15000);
 it.each(['approval','selection'] as const)('serializes approval and preferred selection with %s first',async firstOperation=>{
  const f=await fixture(),submitted=await submit(f,{notes:'approved'}),other=randomUUID(),held=gate(),locked=gate(),waiting=gate();ids.records.add(other);
  await db.populationRecord.create({data:{id:other,villageId:f.villageId,sourceId:f.otherSourceId,population:120,referenceYear:2020,verificationStatus:'VERIFIED',version:1}});
  const find=repository.findForDelete.bind(repository),rows=repository.lockPreferredRows.bind(repository);let holder=0,waiter=0,paused=false,announced=false;
  vi.spyOn(repository,'findForDelete').mockImplementation(async(id,client)=>{const pid=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;if(firstOperation==='selection'&&!announced){announced=true;waiter=pid;waiting.release();}const result=await find(id,client);if(firstOperation==='approval'&&!paused){paused=true;holder=pid;locked.release();await deadline(held.wait);}return result;});
  vi.spyOn(repository,'lockPreferredRows').mockImplementation(async(idsToLock,client)=>{const pid=(await client.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;if(firstOperation==='approval'){waiter=pid;waiting.release();}const result=await rows(idsToLock,client);if(firstOperation==='selection'){paused=true;holder=pid;locked.release();await deadline(held.wait);}return result;});
  const approveId=requestId(),selectId=requestId();const approveAction=()=>settled(Promise.resolve(approve(f,submitted.body.data.id,approveId)));const selectAction=()=>settled(population.selectPreferred(other,{expectedVersion:1,expectedPreferred:{id:f.id,version:3}},{actorId:f.adminId,role:'ADMIN',requestId:selectId}));
  const first=firstOperation==='approval'?approveAction():selectAction();let second:ReturnType<typeof approveAction>|ReturnType<typeof selectAction>|undefined;
  try{await deadline(locked.wait);second=firstOperation==='approval'?selectAction():approveAction();await deadline(waiting.wait);await blockedBy(waiter,holder);}finally{held.release();await first;if(second)await second;}
  const a=await first,b=await second!;expect(a.ok).toBe(true);if(firstOperation==='approval'){expect((a as {ok:true;value:Awaited<ReturnType<typeof approve>>}).value.status).toBe(200);expect(b.ok).toBe(false);}else{expect(b.ok&&(b.value as Awaited<ReturnType<typeof approve>>).status).toBe(409);}
 },15000);
 it.each(['business key','preferred slot'] as const)('rolls back a %s uniqueness conflict',async kind=>{
  const f=await fixture(),submitted=await submit(f,{referenceYear:2021}),other=randomUUID();ids.records.add(other);
  await db.populationRecord.create({data:{id:other,villageId:f.villageId,sourceId:kind==='business key'?f.sourceId:f.otherSourceId,population:120,referenceYear:2021,verificationStatus:'VERIFIED',isPreferred:kind==='preferred slot'}});
  const before=await db.populationRecord.findUniqueOrThrow({where:{id:f.id}}),rid=requestId();expect((await approve(f,submitted.body.data.id,rid)).status).toBe(409);expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toEqual(before);expect((await db.changeRequest.findUniqueOrThrow({where:{id:submitted.body.data.id}})).status).toBe('PENDING');expect(await db.auditLog.count({where:{requestId:rid}})).toBe(0);
 });
 it.each([[2147483646,200],[2147483647,409]] as const)('handles version %i',async(version,status)=>{
  const f=await fixture(),submitted=await submit(f,{notes:'changed'});await db.populationRecord.update({where:{id:f.id},data:{version}});await db.changeRequest.update({where:{id:submitted.body.data.id},data:{baseVersion:version}});
  const rid=requestId();expect((await approve(f,submitted.body.data.id,rid)).status).toBe(status);expect((await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).version).toBe(2147483647);expect((await db.changeRequest.findUniqueOrThrow({where:{id:submitted.body.data.id}})).status).toBe(status===200?'APPROVED':'PENDING');expect(await db.auditLog.count({where:{requestId:rid}})).toBe(status===200?2:0);
 });
 it('rejects malformed stored proposals without changing state',async()=>{
  const f=await fixture(),submitted=await submit(f,{notes:'changed'}),id=submitted.body.data.id;
  await db.changeRequest.update({where:{id},data:{proposedChanges:{isPreferred:false}}});const before=await db.populationRecord.findUniqueOrThrow({where:{id:f.id}}),rid=requestId();
  expect((await approve(f,id,rid)).status).toBe(409);expect(await db.populationRecord.findUniqueOrThrow({where:{id:f.id}})).toEqual(before);expect((await db.changeRequest.findUniqueOrThrow({where:{id}})).status).toBe('PENDING');expect(await db.auditLog.count({where:{requestId:rid}})).toBe(0);
 });
});
