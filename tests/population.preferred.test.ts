import { Prisma, type PopulationRecord } from '@prisma/client';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError } from '../src/shared/errors.js';
import { selectPreferredSchema } from '../src/modules/population/population.schemas.js';
import { PopulationService } from '../src/modules/population/population.service.js';

const audit=vi.hoisted(()=>vi.fn());
const transaction=vi.hoisted(()=>vi.fn());
vi.mock('../src/modules/audit/audit.service.js',()=>({recordAudit:audit}));
vi.mock('../src/shared/db.js',()=>({prisma:{$transaction:transaction}}));
vi.mock('../src/shared/cache.js',()=>({redis:{}}));
const id='11111111-1111-4111-8111-111111111111', oldId='22222222-2222-4222-8222-222222222222', villageId='33333333-3333-4333-8333-333333333333', sourceId='44444444-4444-4444-8444-444444444444', actor='55555555-5555-4555-8555-555555555555';
const context={actorId:actor,role:'REVIEWER' as const,requestId:'preferred-test'};
const tx={};
const repo={preferredTransaction:vi.fn(),transaction:vi.fn(),findLatestVerified:vi.fn(),create:vi.fn(),findForUpdate:vi.fn(),findForDelete:vi.fn(),review:vi.fn(),softDelete:vi.fn(),update:vi.fn(),findMany:vi.fn(),findById:vi.fn(),lockPreferredGroup:vi.fn(),findPreferredSlot:vi.fn(),lockPreferredRows:vi.fn(),setPreferred:vi.fn()};
const villages={ensureExists:vi.fn()};
let target:PopulationRecord, previous:PopulationRecord;
let app:Express;
beforeAll(async()=>{
 vi.stubEnv('NODE_ENV','test');vi.stubEnv('LOG_LEVEL','silent');vi.stubEnv('DATABASE_URL','postgresql://user:pass@localhost:5432/db');vi.stubEnv('REDIS_URL','redis://localhost:6379');vi.stubEnv('JWT_ACCESS_SECRET','test-secret-with-at-least-32-characters');vi.stubEnv('RATE_LIMIT_ENABLED','false');
 app=(await import('../src/app.js')).createApp();
});
beforeEach(()=>{
 vi.resetAllMocks();
 target={id,villageId,sourceId,population:100,referenceYear:2020,referenceDate:null,isEstimate:false,isPreferred:false,needsReview:true,notes:'preserve',verificationStatus:'VERIFIED',version:4,verifiedById:actor,verifiedAt:new Date('2026-01-01Z'),createdById:actor,updatedById:null,createdAt:new Date('2025-01-01Z'),updatedAt:new Date('2025-01-01Z'),deletedAt:null};
 previous={...target,id:oldId,version:7,isPreferred:true,verificationStatus:'PENDING'};
 repo.findById.mockImplementation(async()=>({...target}));
 repo.preferredTransaction.mockImplementation(async (fn:(client:typeof tx)=>unknown)=>fn(tx));
 villages.ensureExists.mockResolvedValue(undefined); repo.lockPreferredGroup.mockResolvedValue(undefined);
 repo.findPreferredSlot.mockImplementation(async()=>({...previous}));
 repo.lockPreferredRows.mockImplementation(async()=>[{...target},{...previous}]);
 repo.setPreferred.mockImplementation(async (recordId:string,_version:number,wasPreferred:boolean)=>({...recordId===id?target:previous,isPreferred:!wasPreferred,version:recordId===id?5:8,updatedById:actor}));
 audit.mockResolvedValue({});
});
const service=()=>new PopulationService(repo,villages);
const input=()=>({expectedVersion:4,expectedPreferred:{id:oldId,version:7}});
describe('Population preferred selection',()=>{
 it.each(['target','previous'] as const)('rejects exhausted %s before either write or audit',async which=>{
  if(which==='target') target.version=2147483647; else previous.version=2147483647;
  await expect(service().selectPreferred(id,{expectedVersion:target.version,expectedPreferred:{id:oldId,version:previous.version}},context)).rejects.toMatchObject({statusCode:409,code:'CONFLICT'});
  expect(repo.setPreferred).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
 });
 it('allows an already preferred maximum-version no-op and rejects stale tokens first',async()=>{
  target.version=2147483647; target.isPreferred=true;
  repo.findPreferredSlot.mockImplementation(async()=>({...target})); repo.lockPreferredRows.mockImplementation(async()=>[{...target}]);
  await expect(service().selectPreferred(id,{expectedVersion:2147483646,expectedPreferred:{id,version:target.version}},context)).rejects.toMatchObject({message:'Population record version conflict'});
  expect(await service().selectPreferred(id,{expectedVersion:target.version,expectedPreferred:{id,version:target.version}},context)).toMatchObject({version:target.version,isPreferred:true});
  expect(repo.setPreferred).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
 });
 it('validates both strict body levels and required nullable slot',()=>{
  for(const body of [{},{expectedVersion:4},{expectedVersion:0,expectedPreferred:null},{expectedVersion:2147483648,expectedPreferred:null},{expectedVersion:4,expectedPreferred:{id:oldId,version:0}},{expectedVersion:4,expectedPreferred:{id:'bad',version:7}},{expectedVersion:4,expectedPreferred:{id:oldId,version:7,extra:true}},{expectedVersion:4,expectedPreferred:null,extra:true}]) expect(selectPreferredSchema.safeParse(body).success).toBe(false);
  expect(selectPreferredSchema.safeParse({expectedVersion:1,expectedPreferred:null}).success).toBe(true);
  expect(selectPreferredSchema.safeParse({expectedVersion:2147483647,expectedPreferred:{id:oldId,version:2147483647}}).success).toBe(true);
 });
 it('authenticates and authorizes before route validation or lookup',async()=>{
  const path='/api/v1/population-records/bad/preferred';
  expect((await request(app).post(path).send({})).status).toBe(401);
  const token=jwt.sign({role:'EDITOR'},'test-secret-with-at-least-32-characters',{subject:actor});
  expect((await request(app).post(path).set('Authorization',`Bearer ${token}`).send({})).status).toBe(403);
 });
 it.each(['REVIEWER','ADMIN'] as const)('routes authorized %s requests to the service',async role=>{
  const {populationService}=await import('../src/modules/population/population.service.js');
  const spy=vi.spyOn(populationService,'selectPreferred').mockResolvedValue(target);
  const token=jwt.sign({role},'test-secret-with-at-least-32-characters',{subject:actor});
  const response=await request(app).post(`/api/v1/population-records/${id}/preferred`).set('Authorization',`Bearer ${token}`).send(input());
  expect(response.status).toBe(200);expect(response.body.data.id).toBe(id);expect(spy).toHaveBeenCalledOnce();spy.mockRestore();
 });
 it('validates the request before an authorized service call',async()=>{
  const {populationService}=await import('../src/modules/population/population.service.js');
  const spy=vi.spyOn(populationService,'selectPreferred');
  const token=jwt.sign({role:'REVIEWER'},'test-secret-with-at-least-32-characters',{subject:actor});
  const response=await request(app).post(`/api/v1/population-records/${id}/preferred`).set('Authorization',`Bearer ${token}`).send({expectedVersion:4});
  expect(response.status).toBe(400);expect(spy).not.toHaveBeenCalled();spy.mockRestore();
 });
 it('denies editor at service boundary before lookup',async()=>{
  await expect(service().selectPreferred(id,input(),{...context,role:'EDITOR'})).rejects.toMatchObject({statusCode:403});
  expect(repo.findById).not.toHaveBeenCalled();
 });
 it('replaces a pending preferred record atomically with two guarded updates and audits',async()=>{
  const result=await service().selectPreferred(id,input(),context);
  expect(result).toMatchObject({id,isPreferred:true,version:5,needsReview:true,notes:'preserve',verificationStatus:'VERIFIED'});
  expect(result).not.toHaveProperty('verifiedById');
  expect(repo.setPreferred.mock.calls.map(call=>call.slice(0,4))).toEqual([[oldId,7,true,actor],[id,4,false,actor]]);
  expect(audit).toHaveBeenCalledTimes(2);
  expect(audit.mock.calls[0]![0]).toMatchObject({entityType:'PopulationRecord',entityId:oldId,action:'UPDATE',actorId:actor,requestId:'preferred-test',before:{isPreferred:true,version:7},after:{isPreferred:false,version:8}});
  expect(audit.mock.calls[1]![0]).toMatchObject({entityType:'PopulationRecord',entityId:id,action:'UPDATE',before:{isPreferred:false,version:4},after:{isPreferred:true,version:5,needsReview:true,verifiedById:actor}});
  expect(audit.mock.calls[0]![1]).toBe(tx); expect(audit.mock.calls[1]![1]).toBe(tx);
  expect(villages.ensureExists.mock.invocationCallOrder[0]!).toBeLessThan(repo.lockPreferredGroup.mock.invocationCallOrder[0]!);
  expect(repo.lockPreferredGroup.mock.invocationCallOrder[0]!).toBeLessThan(repo.lockPreferredRows.mock.invocationCallOrder[0]!);
  expect(repo.setPreferred.mock.invocationCallOrder[0]!).toBeLessThan(repo.setPreferred.mock.invocationCallOrder[1]!);
 });
 it('selects the first preferred record when the slot is empty',async()=>{
  repo.findPreferredSlot.mockResolvedValue(null);repo.lockPreferredRows.mockResolvedValue([target]);
  expect(await service().selectPreferred(id,{expectedVersion:4,expectedPreferred:null},context)).toMatchObject({isPreferred:true,version:5});
  expect(repo.setPreferred).toHaveBeenCalledOnce();expect(audit).toHaveBeenCalledOnce();
 });
 it('does not check or lock the associated source',async()=>{
  const {sourceService}=await import('../src/modules/sources/sources.service.js');
  const spy=vi.spyOn(sourceService,'getById');
  await service().selectPreferred(id,input(),context);
  expect(spy).not.toHaveBeenCalled();spy.mockRestore();
 });
 it('returns a matching already-preferred record without writes',async()=>{
  target.isPreferred=true; repo.findPreferredSlot.mockResolvedValue(target);repo.lockPreferredRows.mockResolvedValue([target]);
  expect(await service().selectPreferred(id,{expectedVersion:4,expectedPreferred:{id,version:4}},context)).toMatchObject({id,version:4,isPreferred:true});
  expect(repo.setPreferred).not.toHaveBeenCalled();expect(audit).not.toHaveBeenCalled();
 });
 it('does not increment an already preferred record at the maximum version',async()=>{
  target.isPreferred=true;target.version=2147483647;repo.findPreferredSlot.mockResolvedValue(target);repo.lockPreferredRows.mockResolvedValue([target]);
  const result=await service().selectPreferred(id,{expectedVersion:target.version,expectedPreferred:{id,version:target.version}},context);
  expect(result.version).toBe(2147483647);expect(repo.setPreferred).not.toHaveBeenCalled();expect(audit).not.toHaveBeenCalled();
  expect(result).not.toHaveProperty('deletedAt');expect(result).not.toHaveProperty('createdById');expect(result).not.toHaveProperty('updatedById');expect(result).not.toHaveProperty('verifiedById');expect(result).not.toHaveProperty('verifiedAt');
 });
 it.each([{version:8},{villageId:'different'},{referenceYear:2019}])('rejects a changed locked preferred candidate %j without writes',async change=>{
  repo.lockPreferredRows.mockResolvedValue([target,{...previous,...change}]);
  await expect(service().selectPreferred(id,input(),context)).rejects.toBeInstanceOf(ConflictError);
  expect(repo.setPreferred).not.toHaveBeenCalled();expect(audit).not.toHaveBeenCalled();
 });
 it('rejects an already-preferred target with a stale or absent slot token',async()=>{
  target.isPreferred=true;repo.findPreferredSlot.mockResolvedValue(target);repo.lockPreferredRows.mockResolvedValue([target]);
  await expect(service().selectPreferred(id,{expectedVersion:4,expectedPreferred:null},context)).rejects.toBeInstanceOf(ConflictError);
  await expect(service().selectPreferred(id,{expectedVersion:4,expectedPreferred:{id,version:3}},context)).rejects.toBeInstanceOf(ConflictError);
  expect(repo.setPreferred).not.toHaveBeenCalled();expect(audit).not.toHaveBeenCalled();
 });
 it.each(['PENDING','REJECTED'] as const)('rejects %s targets',async status=>{target.verificationStatus=status;await expect(service().selectPreferred(id,input(),context)).rejects.toBeInstanceOf(ConflictError);expect(repo.setPreferred).not.toHaveBeenCalled();});
 it.each([
  ['target version',{expectedVersion:3,expectedPreferred:{id:oldId,version:7}}],
  ['old version',{expectedVersion:4,expectedPreferred:{id:oldId,version:6}}],
  ['wrong old ID',{expectedVersion:4,expectedPreferred:{id,version:7}}],
  ['unexpected occupied',{expectedVersion:4,expectedPreferred:null}],
 ] as const)('rejects %s without writes',async(_name,requestBody)=>{await expect(service().selectPreferred(id,requestBody,context)).rejects.toBeInstanceOf(ConflictError);expect(repo.setPreferred).not.toHaveBeenCalled();expect(audit).not.toHaveBeenCalled();});
 it('rejects an unexpectedly empty or newly occupied preferred slot',async()=>{
  repo.findPreferredSlot.mockResolvedValue(null);repo.lockPreferredRows.mockResolvedValue([target]);
  await expect(service().selectPreferred(id,input(),context)).rejects.toBeInstanceOf(ConflictError);
  repo.findPreferredSlot.mockResolvedValueOnce(null).mockResolvedValueOnce(previous);
  await expect(service().selectPreferred(id,{expectedVersion:4,expectedPreferred:null},context)).rejects.toBeInstanceOf(ConflictError);
  expect(repo.setPreferred).not.toHaveBeenCalled();
 });
 it('rejects a deleted preferred index occupant without altering it',async()=>{
  previous.deletedAt=new Date();await expect(service().selectPreferred(id,input(),context)).rejects.toBeInstanceOf(ConflictError);expect(repo.setPreferred).not.toHaveBeenCalled();
 });
 it.each([{villageId:'other'},{referenceYear:2019},{verificationStatus:'REJECTED' as const}])('rechecks locked target %j',async change=>{
  repo.lockPreferredRows.mockResolvedValue([{...target,...change},previous]);
  await expect(service().selectPreferred(id,input(),context)).rejects.toBeInstanceOf(ConflictError);expect(audit).not.toHaveBeenCalled();
 });
 it('rejects a missing or soft-deleted target and an inactive village',async()=>{
  repo.findById.mockResolvedValueOnce(null);await expect(service().selectPreferred(id,input(),context)).rejects.toBeInstanceOf(NotFoundError);
  repo.lockPreferredRows.mockResolvedValueOnce([{...target,deletedAt:new Date()},previous]);await expect(service().selectPreferred(id,input(),context)).rejects.toBeInstanceOf(NotFoundError);
  villages.ensureExists.mockRejectedValueOnce(new NotFoundError());await expect(service().selectPreferred(id,input(),context)).rejects.toBeInstanceOf(NotFoundError);
  expect(repo.setPreferred).not.toHaveBeenCalled();expect(audit).not.toHaveBeenCalled();
 });
 it.each([1,2])('propagates failure of guarded update %i without completing the transaction',async index=>{
  repo.setPreferred.mockRejectedValueOnce(new Error('write failure'));
  if(index===2){repo.setPreferred.mockReset().mockResolvedValueOnce({...previous,isPreferred:false,version:8}).mockRejectedValueOnce(new Error('write failure'));}
  await expect(service().selectPreferred(id,input(),context)).rejects.toThrow('write failure');
  expect(repo.setPreferred).toHaveBeenCalledTimes(index);expect(audit).not.toHaveBeenCalled();
 });
 it.each([1,2])('propagates failure of audit %i from the transaction',async index=>{
  if(index===1)audit.mockRejectedValueOnce(new Error('audit failure'));
  else audit.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('audit failure'));
  await expect(service().selectPreferred(id,input(),context)).rejects.toThrow('audit failure');expect(audit).toHaveBeenCalledTimes(index);
 });
 it.each(['P2034','P2010'] as const)('maps recognized concurrency error %s to conflict',async code=>{
  repo.preferredTransaction.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('conflict',{code,clientVersion:'6.19.3',meta:code==='P2010'?{code:'40P01'}:undefined}));
  await expect(service().selectPreferred(id,input(),context)).rejects.toBeInstanceOf(ConflictError);
 });
 it('propagates unrecognized transaction errors',async()=>{
  repo.preferredTransaction.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('other',{code:'P2010',clientVersion:'6.19.3',meta:{code:'42P01'}}));
  await expect(service().selectPreferred(id,input(),context)).rejects.toMatchObject({code:'P2010'});
 });
});
describe('preferred repository guards',()=>{
 it('propagates unrelated PATCH database errors unchanged',async()=>{
  const {populationRepository}=await import('../src/modules/population/population.repository.js');
  const update=vi.fn();const client={populationRecord:{update}} as unknown as Prisma.TransactionClient;
  const unique=new Prisma.PrismaClientKnownRequestError('other',{code:'P2002',clientVersion:'6.19.3',meta:{modelName:'PopulationRecord',target:['id']}});
  const foreignKey=new Prisma.PrismaClientKnownRequestError('other',{code:'P2003',clientVersion:'6.19.3'});
  for(const error of [unique,foreignKey]){update.mockRejectedValueOnce(error);await expect(populationRepository.update(id,{expectedVersion:4,referenceYear:2021},actor,client)).rejects.toBe(error);}
 });
 it('uses READ COMMITTED only for the preferred transaction',async()=>{
  const {populationRepository}=await import('../src/modules/population/population.repository.js');
  const fn=async()=>42;transaction.mockResolvedValue(42);
  await populationRepository.preferredTransaction(fn);
  expect(transaction).toHaveBeenCalledWith(fn,{isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted});
  await populationRepository.transaction(fn);
  expect(transaction).toHaveBeenLastCalledWith(fn);
 });
 it('locks the advisory group before using sorted unique row IDs',async()=>{
  const {populationRepository}=await import('../src/modules/population/population.repository.js');
  const query=vi.fn().mockResolvedValue([]), findMany=vi.fn().mockResolvedValue([]);
  const client={$queryRaw:query,populationRecord:{findMany}} as unknown as Prisma.TransactionClient;
  await populationRepository.lockPreferredGroup(villageId,2020,client);
  await populationRepository.lockPreferredRows([oldId,id,oldId],client);
  expect(query).toHaveBeenCalledTimes(2);
  expect((query.mock.calls[0]![0] as TemplateStringsArray).join('')).toContain('pg_advisory_xact_lock');
  expect(query.mock.calls[0]![1]).toBe(`qaryati:population:preferred:${villageId}:2020`);
  expect((query.mock.calls[1]![0] as TemplateStringsArray).join('')).toContain('ORDER BY id FOR UPDATE');
  expect((query.mock.calls[1]![1] as Prisma.Sql).values).toEqual([id,oldId]);
  expect(findMany).toHaveBeenCalledWith(expect.objectContaining({where:{id:{in:[id,oldId]}}}));
 });
 it('maps only identified preferred-index and guarded-write conflicts',async()=>{
  const {populationRepository}=await import('../src/modules/population/population.repository.js');
  const update=vi.fn(); const client={populationRecord:{update}} as unknown as Prisma.TransactionClient;
  const error=(code:string,target?:unknown)=>new Prisma.PrismaClientKnownRequestError('failure',{code,clientVersion:'6.19.3',meta:{modelName:'PopulationRecord',target}});
  update.mockRejectedValueOnce(error('P2002','population_records_one_preferred_per_year_idx'));
  await expect(populationRepository.setPreferred(id,4,false,actor,client)).rejects.toBeInstanceOf(ConflictError);
  update.mockRejectedValueOnce(error('P2002',['village_id','reference_year']));
  await expect(populationRepository.setPreferred(id,4,false,actor,client)).rejects.toBeInstanceOf(ConflictError);
  update.mockRejectedValueOnce(error('P2025'));
  await expect(populationRepository.setPreferred(id,4,false,actor,client)).rejects.toBeInstanceOf(ConflictError);
  for(const target of [['village_id','reference_year','source_id'],['village_id'],'other_index',undefined]){
   const original=error('P2002',target);update.mockRejectedValueOnce(original);
   await expect(populationRepository.setPreferred(id,4,false,actor,client)).rejects.toBe(original);
  }
 });
});
