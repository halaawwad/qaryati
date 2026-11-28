import { Prisma, type PopulationRecord } from '@prisma/client';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({find:vi.fn(),locked:vi.fn(),lock:vi.fn(),update:vi.fn(),audit:vi.fn(),transaction:vi.fn(),source:vi.fn()}));
vi.mock('../src/shared/db.js', () => ({prisma:{populationRecord:{findFirst:db.find},$transaction:db.transaction}}));
vi.mock('../src/shared/cache.js', () => ({redis:{}}));
const id='11111111-1111-4111-8111-111111111111', villageId='22222222-2222-4222-8222-222222222222', sourceId='33333333-3333-4333-8333-333333333333', actor='55555555-5555-4555-8555-555555555555';
const secret='test-secret-with-at-least-32-characters';
const now=new Date('2026-01-01T00:00:00Z');
const tx={$queryRaw:db.lock,populationRecord:{findFirst:db.locked,update:db.update},auditLog:{create:db.audit},source:{findFirst:db.source}};
let row: PopulationRecord;
let app: Express;
beforeAll(async()=>{
 vi.stubEnv('NODE_ENV','test'); vi.stubEnv('LOG_LEVEL','silent'); vi.stubEnv('DATABASE_URL','postgresql://user:pass@localhost:5432/db'); vi.stubEnv('REDIS_URL','redis://localhost:6379'); vi.stubEnv('JWT_ACCESS_SECRET',secret); vi.stubEnv('RATE_LIMIT_ENABLED','false');
 app=(await import('../src/app.js')).createApp();
});
beforeEach(()=>{
 vi.resetAllMocks();
 row={id,villageId,sourceId,population:100,referenceYear:2021,referenceDate:now,isEstimate:true,isPreferred:true,needsReview:true,notes:'original',verificationStatus:'PENDING',version:2,createdById:'another-creator',updatedById:'previous-updater',verifiedById:null,verifiedAt:null,createdAt:now,updatedAt:now,deletedAt:null};
 const selected=()=>{const {deletedAt:_deletedAt,...record}=row; return record;};
 db.find.mockImplementation(async()=>selected()); db.locked.mockImplementation(async()=>selected());
 db.lock.mockImplementation(async (_query:TemplateStringsArray,value:string)=>[{id:value}]);
 db.transaction.mockImplementation(async (fn:(client:typeof tx)=>unknown)=>fn(tx));
 db.update.mockImplementation(async ({data}:{data:Record<string,unknown>})=>({...selected(),...data,version:row.version+1}));
 db.audit.mockResolvedValue({id:'audit'});
});
function review(action:'verify'|'reject', body:object={expectedVersion:2}, role?:string, path=id) {
 let req=request(app).post(`/api/v1/population-records/${path}/${action}`).set('x-request-id','review-test');
 if(role) req=req.set('Authorization',`Bearer ${jwt.sign({role},secret,{subject:actor,algorithm:'HS256'})}`);
 return req.send(body);
}
describe('population review',()=>{
 it.each(['verify','reject'] as const)('%s guards maximum version after stale and no-op checks',async action=>{
  row.version=2147483647;
  const stale=await review(action,{expectedVersion:2147483646},'ADMIN'); expect(stale.status).toBe(409); expect(stale.body.error.message).toBe('Population record version conflict');
  const exhausted=await review(action,{expectedVersion:2147483647},'ADMIN'); expect(exhausted.status).toBe(409); expect(exhausted.body.error.code).toBe('CONFLICT');
  row.verificationStatus=action==='verify'?'VERIFIED':'REJECTED'; row.needsReview=false;
  expect((await review(action,{expectedVersion:2147483647},'ADMIN')).status).toBe(200);
  expect(db.update).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled();
 });
 it.each(['verify','reject'] as const)('%s authenticates and authorizes before validation and lookup',async action=>{
  expect((await review(action,{},undefined,'bad')).status).toBe(401);
  expect((await review(action,{},'EDITOR','bad')).status).toBe(403);
  expect(db.find).not.toHaveBeenCalled(); expect(db.update).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled();
 });
 it('rejects EDITOR at the service boundary before lookup',async()=>{
  const {populationService}=await import('../src/modules/population/population.service.js');
  await expect(populationService.review(id,{expectedVersion:2},'VERIFIED',{role:'EDITOR',actorId:actor,requestId:'x'})).rejects.toMatchObject({statusCode:403});
  expect(db.find).not.toHaveBeenCalled();
 });
 it.each(['verify','reject'] as const)('%s validates UUID and strict body for an authorized reviewer',async action=>{
  expect((await review(action,{expectedVersion:2},'REVIEWER','bad')).status).toBe(400);
  for(const body of [{},{expectedVersion:0},{expectedVersion:-1},{expectedVersion:1.5},{expectedVersion:2147483648},{expectedVersion:'2'},{expectedVersion:2,reason:'no'},{expectedVersion:2,verificationStatus:'VERIFIED'}]) {
   expect((await review(action,body,'REVIEWER')).status).toBe(400);
  }
  expect(db.find).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled();
 });
 it.each([
  ['PENDING','verify','VERIFIED',true],['VERIFIED','verify','VERIFIED',true],['REJECTED','verify','VERIFIED',true],
  ['PENDING','reject','REJECTED',true],['VERIFIED','reject','REJECTED',true],['REJECTED','reject','REJECTED',false],
 ] as const)('%s + %s yields %s (change: %s)',async (status,action,target,changed)=>{
  row.verificationStatus=status;
  row.verifiedById=actor; row.verifiedAt=now;
  const result=await review(action,{expectedVersion:2},'REVIEWER');
  expect(result.status).toBe(200); expect(result.body.data).toMatchObject({id,verificationStatus:target,version:changed?3:2,needsReview:action==='verify'?false:true,isPreferred:changed && action==='reject'?false:true,sourceId,villageId,population:100,referenceYear:2021,notes:'original'});
  for(const field of ['createdById','updatedById','verifiedById','verifiedAt','deletedAt']) expect(result.body.data).not.toHaveProperty(field);
  if(!changed){expect(db.update).not.toHaveBeenCalled();expect(db.audit).not.toHaveBeenCalled();return;}
  expect(db.update).toHaveBeenCalledOnce(); expect(db.audit).toHaveBeenCalledOnce();
  const write=db.update.mock.calls[0]![0];
  expect(write.where).toEqual({id,deletedAt:null,version:2,verificationStatus:status});
  expect(write.data).toEqual({verificationStatus:target,updatedById:actor,version:{increment:1},verifiedById:action==='verify'?actor:null,verifiedAt:action==='verify'?expect.any(Date):null,...(action==='reject'?{isPreferred:false}:{needsReview:false})});
  expect(db.audit.mock.calls[0]![0].data).toMatchObject({entityType:'PopulationRecord',entityId:id,action:action==='verify'?'VERIFY':'REJECT',actorId:actor,requestId:'review-test',before:{verificationStatus:status,version:2,verifiedById:actor,verifiedAt:now.toISOString(),isPreferred:true,needsReview:true,notes:'original',createdById:'another-creator'},after:{verificationStatus:target,version:3,verifiedById:action==='verify'?actor:null,verifiedAt:action==='verify'?expect.any(String):null,isPreferred:action==='reject'?false:true,needsReview:action==='verify'?false:true,notes:'original',createdById:'another-creator',updatedById:actor}});
 });
 it.each(['verify','reject'] as const)('permits ADMIN to %s without checking source or ownership',async action=>{
  const response=await review(action,{expectedVersion:2},'ADMIN');
  expect(response.status).toBe(200); expect(db.source).not.toHaveBeenCalled();
  expect(db.lock.mock.calls.map(call=>(call[0] as TemplateStringsArray).join(''))).toEqual([expect.stringContaining('FROM villages'),expect.stringContaining('FROM population_records')]);
  expect(db.update).toHaveBeenCalledOnce();
 });
 it.each([['VERIFIED','verify'],['REJECTED','reject'],['PENDING','verify'],['PENDING','reject']] as const)('rejects stale %s %s before no-op or write',async(status,action)=>{
  row.verificationStatus=status; expect((await review(action,{expectedVersion:1},'ADMIN')).status).toBe(409); expect(db.update).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled();
 });
 it('uses locked status and version rather than the initial read',async()=>{
  db.locked.mockImplementationOnce(async()=>({...row,version:4,verificationStatus:'VERIFIED'}));
  expect((await review('verify',{expectedVersion:2},'ADMIN')).status).toBe(409);
  expect(db.update).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled();
 });
 // These deliberately inconsistent snapshots test the service's defensive contract;
 // they do not imply normal production writes can change status without changing version.
 it('returns a no-op when only the locked status already matches',async()=>{
  row.verificationStatus='PENDING';
  const {deletedAt:_deletedAt,...locked}=row;
  db.locked.mockResolvedValueOnce({...locked,verificationStatus:'VERIFIED',needsReview:false});
  const response=await review('verify',{expectedVersion:2},'REVIEWER');
  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({verificationStatus:'VERIFIED',version:2});
  expect(db.update).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled();
 });
 it('transitions when only the locked status differs from the requested status',async()=>{
  row.verificationStatus='VERIFIED';
  const {deletedAt:_deletedAt,...locked}=row;
  db.locked.mockResolvedValueOnce({...locked,verificationStatus:'PENDING'});
  const response=await review('verify',{expectedVersion:2},'REVIEWER');
  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({verificationStatus:'VERIFIED',version:3});
  expect(db.update).toHaveBeenCalledOnce();
  expect(db.update.mock.calls[0]![0]).toMatchObject({where:{version:2,verificationStatus:'PENDING'},data:{verificationStatus:'VERIFIED',version:{increment:1}}});
  expect(db.audit).toHaveBeenCalledOnce();
  expect(db.audit.mock.calls[0]![0].data).toMatchObject({action:'VERIFY',before:{verificationStatus:'PENDING',version:2},after:{verificationStatus:'VERIFIED',version:3}});
 });
 it.each([[1,true],[2147483647,true],[0,false],[2147483648,false]] as const)('validates expectedVersion %i as %s',async(version,valid)=>{
  const {reviewPopulationSchema}=await import('../src/modules/population/population.schemas.js');
  expect(reviewPopulationSchema.safeParse({expectedVersion:version}).success).toBe(valid);
 });
 it('rejects clearing needsReview at maximum version without mutation',async()=>{ row.version=2147483647; row.verificationStatus='VERIFIED'; expect((await review('verify',{expectedVersion:2147483647},'ADMIN')).status).toBe(409); expect(db.update).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled(); });
 it.each([true,false])('reject preserves needsReview=%s',async flag=>{row.needsReview=flag; const response=await review('reject',{expectedVersion:2},'ADMIN'); expect(response.body.data.needsReview).toBe(flag); expect(db.audit.mock.calls[0][0].data.after.needsReview).toBe(flag);});
 it('returns a matching maximum-version same-status request without increment or audit',async()=>{
  row.version=2147483647; row.verificationStatus='VERIFIED'; row.needsReview=false;
  const response=await review('verify',{expectedVersion:2147483647},'REVIEWER');
  expect(response.status).toBe(200); expect(response.body.data.version).toBe(2147483647);
  expect(db.update).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled();
 });
 it('returns 404 for missing, concurrently deleted, inactive village, or changed parent',async()=>{
  db.find.mockResolvedValueOnce(null); expect((await review('verify',{expectedVersion:2},'ADMIN')).status).toBe(404);
  db.lock.mockResolvedValueOnce([]); expect((await review('verify',{expectedVersion:2},'ADMIN')).status).toBe(404);
  db.lock.mockResolvedValueOnce([{id:villageId}]).mockResolvedValueOnce([]); expect((await review('verify',{expectedVersion:2},'ADMIN')).status).toBe(404);
  db.locked.mockResolvedValueOnce({...row,villageId:'other'}); expect((await review('reject',{expectedVersion:2},'ADMIN')).status).toBe(404);
  expect(db.update).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled();
 });
 it('maps a guarded-write miss to 409 without audit',async()=>{
  db.update.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('missing',{code:'P2025',clientVersion:'6.19.3'}));
  expect((await review('verify',{expectedVersion:2},'ADMIN')).status).toBe(409); expect(db.audit).not.toHaveBeenCalled();
 });
 it('propagates audit failure from the mocked transaction',async()=>{
  db.audit.mockRejectedValueOnce(new Error('audit failure'));
  expect((await review('reject',{expectedVersion:2},'ADMIN')).status).toBe(500);
  expect(db.update).toHaveBeenCalledOnce(); expect(db.audit).toHaveBeenCalledOnce(); expect(db.transaction).toHaveBeenCalledOnce();
 });
 it('rejects a soft-deleted or missing locked row',async()=>{
  db.locked.mockResolvedValueOnce(null);
  expect((await review('verify',{expectedVersion:2},'ADMIN')).status).toBe(404);
  expect(db.audit).not.toHaveBeenCalled(); expect(db.update).not.toHaveBeenCalled();
 });
});
