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
beforeAll(async()=>{
 validateTarget();
 try {
  const {PrismaClient}=await import('@prisma/client');db=new PrismaClient({log:[]});
  const identity=await db.$queryRaw<Array<{database:string;username:string}>>`SELECT current_database() AS database, current_user AS username`;
  if(identity.length!==1||identity[0]?.database!=='qaryati_local'||identity[0]?.username!=='qaryati_local') throw new Error();
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
 const audits=await db.auditLog.findMany({where:{OR:[{entityType:'PopulationRecord',entityId:{in:[...ids.records]}},{entityType:'ChangeRequest',entityId:{in:changes.map(c=>c.id)}}]},select:{id:true,actorId:true,requestId:true}});
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
