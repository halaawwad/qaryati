import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let db: PrismaClient;
let app: Express;
let verified = false;
const ids={governorate:randomUUID(),villages:[randomUUID(),randomUUID(),randomUUID()],sources:[randomUUID(),randomUUID()],records:Array.from({length:8},()=>randomUUID())};
const [village,otherVillage,inactiveVillage]=ids.villages as [string,string,string];
const [source,deletedSource]=ids.sources as [string,string];
const [preferred2021,preferred2020,other2020,preferred2019,other2018,deletedRecord,otherVillageRecord,inactiveVillageRecord]=ids.records as [string,string,string,string,string,string,string,string];

function validateTarget(): void {
 if(process.env.QARYATI_POSTGRES_INTEGRATION!=='1')throw new Error('PostgreSQL integration opt-in required');
 try{
  const url=new URL(process.env.DATABASE_URL??'');
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.port!=='55433'||url.pathname!=='/qaryati_local'||url.hash||[...url.searchParams.keys()].some(key=>key!=='schema')||(url.searchParams.has('schema')&&url.searchParams.get('schema')!=='public'))throw new Error();
 }catch{throw new Error('Integration database target is not allowed');}
}
const path=(id=village)=>`/api/v1/villages/${id}/population-records`;
const recordIds=(body:{data:Array<{id:string}>})=>body.data.map(item=>item.id);

beforeAll(async()=>{
 validateTarget();
 try{
  const {PrismaClient}=await import('@prisma/client');db=new PrismaClient({log:[]});
  const identity=await db.$queryRaw<Array<{database:string;username:string}>>`SELECT current_database() AS database,current_user AS username`;
  if(identity.length!==1||identity[0]?.database!=='qaryati_local'||identity[0]?.username!=='qaryati_local')throw new Error();
  verified=true;
  vi.stubEnv('NODE_ENV','test');vi.stubEnv('LOG_LEVEL','silent');vi.stubEnv('RATE_LIMIT_ENABLED','false');vi.stubEnv('REDIS_URL','redis://127.0.0.1:6379');vi.stubEnv('JWT_ACCESS_SECRET','population-integration-test-secret-at-least-32-characters');
  vi.doMock('../../src/shared/db.js',()=>({prisma:db}));vi.doMock('../../src/shared/cache.js',()=>({redis:{}}));
  app=(await import('../../src/app.js')).createApp();
  await db.governorate.create({data:{id:ids.governorate,nameAr:`ar-${ids.governorate}`,nameEn:`en-${ids.governorate}`,code:`i-${ids.governorate}`}});
  await db.village.createMany({data:ids.villages.map((id,index)=>({id,governorateId:ids.governorate,slug:`integration-${id}`,nameAr:'Integration',deletedAt:index===2?new Date():null}))});
  await db.source.createMany({data:[{id:source,title:'first',sourceType:'BOOK'},{id:deletedSource,title:'deleted',sourceType:'BOOK',deletedAt:new Date()}]});
  await db.populationRecord.createMany({data:[
   {id:preferred2021,villageId:village,sourceId:deletedSource,referenceYear:2021,population:101,isPreferred:true,verificationStatus:'VERIFIED'},
   {id:preferred2020,villageId:village,sourceId:source,referenceYear:2020,population:100,isPreferred:true,verificationStatus:'PENDING',needsReview:true,isEstimate:true},
   {id:other2020,villageId:village,sourceId:deletedSource,referenceYear:2020,population:105,verificationStatus:'VERIFIED'},
   {id:preferred2019,villageId:village,sourceId:source,referenceYear:2019,population:90,isPreferred:true,verificationStatus:'REJECTED'},
   {id:other2018,villageId:village,sourceId:source,referenceYear:2018,population:80},
   {id:deletedRecord,villageId:village,sourceId:source,referenceYear:2017,population:70,isPreferred:true,deletedAt:new Date()},
   {id:otherVillageRecord,villageId:otherVillage,sourceId:source,referenceYear:2020,population:200,isPreferred:true},
   {id:inactiveVillageRecord,villageId:inactiveVillage,sourceId:source,referenceYear:2020,population:300,isPreferred:true,verificationStatus:'VERIFIED'},
  ]});
 }catch{
  if(db)await db.$disconnect();throw new Error('Could not verify or initialize integration database');
 }
});
afterAll(async()=>{
 if(!db)return;
 try{if(verified){
  await db.populationRecord.deleteMany({where:{id:{in:ids.records}}});
  await db.village.deleteMany({where:{id:{in:ids.villages}}});
  await db.source.deleteMany({where:{id:{in:ids.sources}}});
  await db.governorate.deleteMany({where:{id:ids.governorate}});
 }}finally{await db.$disconnect();}
});

describe('Population preferred-default reads with PostgreSQL',()=>{
 it('returns preferred records by default, including legacy statuses and deleted sources',async()=>{
  const response=await request(app).get(path());expect(response.status).toBe(200);
  expect(recordIds(response.body)).toEqual([preferred2021,preferred2020,preferred2019]);expect(response.body.meta.total).toBe(3);
  expect(response.body.data).toEqual(expect.arrayContaining([expect.objectContaining({id:preferred2021,sourceId:deletedSource}),expect.objectContaining({id:preferred2020,verificationStatus:'PENDING'}),expect.objectContaining({id:preferred2019,verificationStatus:'REJECTED'})]));
  for(const field of ['createdById','updatedById','verifiedById','verifiedAt','deletedAt'])expect(response.body.data[0]).not.toHaveProperty(field);
 });
 it('supports explicit preferred, nonpreferred and all records without a fallback',async()=>{
  const preferred=await request(app).get(path()).query({isPreferred:'true'});expect(recordIds(preferred.body)).toEqual([preferred2021,preferred2020,preferred2019]);
  const other=await request(app).get(path()).query({isPreferred:'false'});expect(recordIds(other.body)).toEqual([other2020,other2018]);expect(other.body.meta.total).toBe(2);
  const all=await request(app).get(path()).query({includeAll:'true'});expect(new Set(recordIds(all.body))).toEqual(new Set([preferred2021,preferred2020,other2020,preferred2019,other2018]));expect(all.body.meta.total).toBe(5);
  expect((await request(app).get(path()).query({referenceYear:'2018'})).body.data).toEqual([]);
  expect(recordIds((await request(app).get(path()).query({includeAll:'true',referenceYear:'2018'})).body)).toEqual([other2018]);
 });
 it('validates Boolean combinations and ignores unknown keys',async()=>{
  for(const isPreferred of ['true','false']){
   expect((await request(app).get(path()).query({includeAll:'true',isPreferred})).status).toBe(400);
   const response=await request(app).get(path()).query({includeAll:'false',isPreferred});expect(response.status).toBe(200);
   expect(recordIds(response.body)).toEqual(isPreferred==='true'?[preferred2021,preferred2020,preferred2019]:[other2020,other2018]);
  }
  const defaults=await request(app).get(path()).query({includeAll:'false',unknown:'ignored'});expect(recordIds(defaults.body)).toEqual([preferred2021,preferred2020,preferred2019]);
  for(const query of [{includeAll:'yes'},{isPreferred:'TRUE'}])expect((await request(app).get(path()).query(query)).status).toBe(400);
 });
 it('intersects existing filters and returns consistent paginated totals and ordering',async()=>{
  const filtered=await request(app).get(path()).query({referenceYear:'2020',sourceId:source,isEstimate:'true',needsReview:'true',verificationStatus:'PENDING'});
  expect(recordIds(filtered.body)).toEqual([preferred2020]);expect(filtered.body.meta.total).toBe(1);
  const absent=await request(app).get(path()).query({referenceYear:'2020',sourceId:deletedSource,verificationStatus:'VERIFIED'});expect(absent.body.data).toEqual([]);
  const all=await request(app).get(path()).query({includeAll:'true',referenceYear:'2020',sourceId:deletedSource,verificationStatus:'VERIFIED'});expect(recordIds(all.body)).toEqual([other2020]);
  const first=await request(app).get(path()).query({includeAll:'true',page:1,limit:2});const second=await request(app).get(path()).query({includeAll:'true',page:2,limit:2});const third=await request(app).get(path()).query({includeAll:'true',page:3,limit:2});
  expect(first.body.meta).toMatchObject({total:5,totalPages:3,page:1});expect(second.body.meta.total).toBe(5);expect(third.body.meta.total).toBe(5);
  expect([...recordIds(first.body),...recordIds(second.body),...recordIds(third.body)]).toEqual([preferred2021,...[preferred2020,other2020].sort(),preferred2019,other2018]);
 });
 it('keeps village isolation and detail access without writing rows or audits',async()=>{
  const before=await db.populationRecord.findMany({where:{id:{in:ids.records}},orderBy:{id:'asc'}});
  const inactiveBefore=await db.populationRecord.findUniqueOrThrow({where:{id:inactiveVillageRecord}});
  expect(inactiveBefore).toMatchObject({villageId:inactiveVillage,isPreferred:true,deletedAt:null,verificationStatus:'VERIFIED'});
  expect(recordIds((await request(app).get(path(otherVillage)).query({includeAll:'true'})).body)).toEqual([otherVillageRecord]);
  expect((await request(app).get(path(inactiveVillage))).status).toBe(404);
  expect((await request(app).get(path(inactiveVillage)).query({includeAll:'true'})).status).toBe(404);
  expect((await request(app).get(`/api/v1/population-records/${inactiveVillageRecord}`)).status).toBe(404);
  const detail=await request(app).get(`/api/v1/population-records/${other2020}`);expect(detail.status).toBe(200);expect(detail.body.data).toMatchObject({id:other2020,isPreferred:false,sourceId:deletedSource});
  expect((await request(app).get(`/api/v1/population-records/${deletedRecord}`)).status).toBe(404);
  expect(await db.populationRecord.findMany({where:{id:{in:ids.records}},orderBy:{id:'asc'}})).toEqual(before);
  expect(await db.populationRecord.findUniqueOrThrow({where:{id:inactiveVillageRecord}})).toEqual(inactiveBefore);
  expect(await db.auditLog.count({where:{entityId:{in:ids.records}}})).toBe(0);
 });
});
