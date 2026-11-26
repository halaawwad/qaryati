import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let db:PrismaClient,app:Express,verified=false;
const secret='population-integration-test-secret-at-least-32-characters';
const ids={users:new Set<string>(),governors:new Set<string>(),villages:new Set<string>(),sources:new Set<string>(),records:new Set<string>(),changes:new Set<string>()};
function validateTarget():void {
 if(process.env.QARYATI_POSTGRES_INTEGRATION!=='1')throw new Error('PostgreSQL integration opt-in required');
 try {const url=new URL(process.env.DATABASE_URL??'');if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.port!=='55433'||url.pathname!=='/qaryati_local'||url.hash||[...url.searchParams.keys()].some(key=>key!=='schema')||(url.searchParams.has('schema')&&url.searchParams.get('schema')!=='public'))throw new Error();}catch{throw new Error('Integration database target is not allowed');}
}
beforeAll(async()=>{
 validateTarget();
 try {
  const {PrismaClient}=await import('@prisma/client');db=new PrismaClient({log:[]});
  const identity=await db.$queryRaw<Array<{database:string;username:string}>>`SELECT current_database() AS database,current_user AS username`;
  if(identity.length!==1||identity[0]?.database!=='qaryati_local'||identity[0]?.username!=='qaryati_local')throw new Error();
  verified=true;vi.stubEnv('NODE_ENV','test');vi.stubEnv('LOG_LEVEL','silent');vi.stubEnv('RATE_LIMIT_ENABLED','false');vi.stubEnv('REDIS_URL','redis://127.0.0.1:6379');vi.stubEnv('JWT_ACCESS_SECRET',secret);
  vi.doMock('../../src/shared/db.js',()=>({prisma:db}));vi.doMock('../../src/shared/cache.js',()=>({redis:{}}));app=(await import('../../src/app.js')).createApp();
 } catch {if(db)await db.$disconnect();throw new Error('Could not verify integration database identity or initialize test services');}
});
afterEach(async()=>{
 if(!verified)return;
 const rows=await db.changeRequest.findMany({where:{id:{in:[...ids.changes]}},select:{id:true,requestedById:true}});
 if(rows.some(row=>!ids.users.has(row.requestedById)))throw new Error('Change request fixture ownership could not be established');
 const audit=await db.auditLog.findMany({where:{OR:[{entityType:'ChangeRequest',entityId:{in:[...ids.changes]}},{entityType:'PopulationRecord',entityId:{in:[...ids.records]}}]},select:{id:true,actorId:true}});
 if(audit.some(row=>!row.actorId||!ids.users.has(row.actorId)))throw new Error('Audit fixture ownership could not be established');
 await db.auditLog.deleteMany({where:{id:{in:audit.map(row=>row.id)}}});await db.changeRequest.deleteMany({where:{id:{in:[...ids.changes]}}});
 await db.populationRecord.deleteMany({where:{id:{in:[...ids.records]}}});await db.village.deleteMany({where:{id:{in:[...ids.villages]}}});await db.source.deleteMany({where:{id:{in:[...ids.sources]}}});
 await db.governorate.deleteMany({where:{id:{in:[...ids.governors]}}});await db.user.deleteMany({where:{id:{in:[...ids.users]}}});for(const set of Object.values(ids))set.clear();
});
afterAll(async()=>{if(db)await db.$disconnect();});
async function fixture(){
 const editor=randomUUID(),other=randomUUID(),reviewer=randomUUID(),admin=randomUUID(),governorate=randomUUID(),village=randomUUID(),source=randomUUID(),population=randomUUID();
 const changeIds=Array.from({length:4},()=>randomUUID()).sort();
 for(const value of [editor,other,reviewer,admin])ids.users.add(value);ids.governors.add(governorate);ids.villages.add(village);ids.sources.add(source);ids.records.add(population);for(const value of changeIds)ids.changes.add(value);
 await db.user.createMany({data:[{id:editor,email:`${editor}@integration.invalid`,fullName:'Editor',passwordHash:'private',role:'EDITOR'},{id:other,email:`${other}@integration.invalid`,fullName:'Other',passwordHash:'private',role:'EDITOR'},{id:reviewer,email:`${reviewer}@integration.invalid`,fullName:'Reviewer',passwordHash:'private',role:'REVIEWER'},{id:admin,email:`${admin}@integration.invalid`,fullName:'Admin',passwordHash:'private',role:'ADMIN'}]});
 await db.governorate.create({data:{id:governorate,nameAr:`ar-${governorate}`,nameEn:`en-${governorate}`,code:`i-${governorate}`}});
 await db.village.create({data:{id:village,governorateId:governorate,slug:`integration-${village}`,nameAr:'Integration'}});await db.source.create({data:{id:source,title:'source',sourceType:'BOOK'}});
 await db.populationRecord.create({data:{id:population,villageId:village,sourceId:source,population:100,referenceYear:2020,verificationStatus:'VERIFIED',createdById:admin}});
 const time=new Date('2026-01-01T00:00:00Z'),proposal={referenceDate:'2024-01-01T12:00:00+02:00',notes:null,isEstimate:false};
 await db.changeRequest.createMany({data:changeIds.map((id,index)=>({id,entityType:'PopulationRecord',entityId:population,baseVersion:1,proposedChanges:proposal,requestedById:index<2?editor:other,status:(['PENDING','APPROVED','REJECTED','PENDING'] as const)[index]!,createdAt:time,updatedAt:time}))});
 return {editor,other,reviewer,admin,village,source,population,changeIds,proposal};
}
function get(path:string,subject?:string,role?:string){let req=request(app).get(path).set('X-Request-Id','read-integration');if(subject&&role)req=req.set('Authorization',`Bearer ${jwt.sign({role},secret,{subject})}`);return req;}
const endpoint='/api/v1/change-requests';
async function snapshots(f:Awaited<ReturnType<typeof fixture>>){return {changes:await db.changeRequest.findMany({where:{id:{in:f.changeIds}},orderBy:{id:'asc'}}),population:await db.populationRecord.findUniqueOrThrow({where:{id:f.population}}),audits:await db.auditLog.findMany({where:{OR:[{entityType:'ChangeRequest',entityId:{in:f.changeIds}},{entityType:'PopulationRecord',entityId:f.population}]},orderBy:{id:'asc'}})};}
describe('Change Request read HTTP with PostgreSQL',()=>{
 it('enforces ownership, filtered counts and indistinguishable detail 404s',async()=>{
  const f=await fixture(),before=await snapshots(f);
  expect((await get(endpoint)).status).toBe(401);expect((await get(`${endpoint}/${f.changeIds[0]}`)).status).toBe(401);
  const list=await get(endpoint,f.editor,'EDITOR');expect(list.status).toBe(200);expect(list.body.meta.total).toBe(2);expect(list.body.data.map((x:{id:string})=>x.id)).toEqual(f.changeIds.slice(0,2));expect(list.body.data.every((x:{requestedById:string})=>x.requestedById===f.editor)).toBe(true);
  expect((await get(`${endpoint}/${f.changeIds[0]}`,f.editor,'EDITOR')).status).toBe(200);
  const hidden=await get(`${endpoint}/${f.changeIds[2]}`,f.editor,'EDITOR'),missing=await get(`${endpoint}/${randomUUID()}`,f.editor,'EDITOR');expect(hidden.status).toBe(404);expect(missing.status).toBe(404);expect(hidden.body.error).toEqual(missing.body.error);
  expect((await get(`${endpoint}?requestedById=${f.other}`,f.editor,'EDITOR')).status).toBe(403);
  const filtered=await get(`${endpoint}?status=PENDING&entityType=PopulationRecord&entityId=${f.population}`,f.editor,'EDITOR');expect(filtered.body.meta.total).toBe(1);expect(filtered.body.data.map((x:{id:string})=>x.id)).toEqual([f.changeIds[0]]);
  expect(await snapshots(f)).toEqual(before);
 });
 it.each(['REVIEWER','ADMIN'] as const)('allows %s to filter, page and read historical records',async role=>{
  const f=await fixture(),subject=role==='ADMIN'?f.admin:f.reviewer,before=await snapshots(f);
  const first=await get(`${endpoint}?page=1&limit=2`,subject,role),second=await get(`${endpoint}?page=2&limit=2`,subject,role);
  expect(first.status).toBe(200);expect(first.body.meta).toMatchObject({total:4,totalPages:2,hasNextPage:true});expect(second.body.meta).toMatchObject({total:4,hasPrevPage:true});expect([...first.body.data,...second.body.data].map((x:{id:string})=>x.id)).toEqual(f.changeIds);
  for(const [query,total] of [[`status=PENDING`,2],[`status=APPROVED`,1],[`status=REJECTED`,1],[`entityType=PopulationRecord`,4],[`entityId=${f.population}`,4],[`requestedById=${f.other}`,2],[`status=PENDING&entityType=PopulationRecord&entityId=${f.population}&requestedById=${f.other}`,1],[`entityId=${randomUUID()}`,0]] as const){const res=await get(`${endpoint}?${query}`,subject,role);expect(res.status).toBe(200);expect(res.body.meta.total).toBe(total);expect(res.body.data).toHaveLength(total);}
  const detail=await get(`${endpoint}/${f.changeIds[2]}`,subject,role);expect(detail.status).toBe(200);expect(detail.body.data.proposedChanges).toEqual(f.proposal);expect(detail.body.data).not.toHaveProperty('passwordHash');expect(detail.body.data).not.toHaveProperty('token');
  expect(await snapshots(f)).toEqual(before);
 });
 it('reads history after Population and source deletion',async()=>{
  const f=await fixture();await db.populationRecord.update({where:{id:f.population},data:{population:555,deletedAt:new Date()}});await db.source.update({where:{id:f.source},data:{deletedAt:new Date()}});await db.village.update({where:{id:f.village},data:{deletedAt:new Date()}});
  const before=await snapshots(f),detail=await get(`${endpoint}/${f.changeIds[0]}`,f.editor,'EDITOR'),list=await get(`${endpoint}?entityId=${f.population}`,f.editor,'EDITOR');expect(detail.status).toBe(200);expect(detail.body.data.proposedChanges).toEqual(f.proposal);expect(list.body.meta.total).toBe(2);expect(await snapshots(f)).toEqual(before);
 });
 it('rejects invalid and repeated supported query parameters',async()=>{
  const f=await fixture(),before=await snapshots(f);
  for(const query of ['page=0','page=1&page=2','limit=1&limit=2','status=BAD','status=PENDING&status=APPROVED','entityType=Village','entityId=bad','requestedById=bad',`entityId=${f.population}&entityId=${f.population}`])expect((await get(`${endpoint}?${query}`,f.admin,'ADMIN')).status).toBe(400);
  expect((await get(`${endpoint}/bad`,f.admin,'ADMIN')).status).toBe(400);expect(await snapshots(f)).toEqual(before);
 });
});
