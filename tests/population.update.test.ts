import { Prisma } from '@prisma/client';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({find:vi.fn(), lockedFind:vi.fn(), baseline:vi.fn(), lock:vi.fn(), source:vi.fn(), update:vi.fn(), audit:vi.fn(), transaction:vi.fn()}));
vi.mock('../src/shared/db.js', () => ({prisma:{populationRecord:{findFirst:db.find}, $transaction:db.transaction}}));
vi.mock('../src/shared/cache.js', () => ({redis:{}}));
const id='11111111-1111-4111-8111-111111111111', villageId='22222222-2222-4222-8222-222222222222', sourceId='33333333-3333-4333-8333-333333333333', otherSource='44444444-4444-4444-8444-444444444444', actor='55555555-5555-4555-8555-555555555555';
const secret='test-secret-with-at-least-32-characters';
const tx={$queryRaw:db.lock, populationRecord:{findFirst:(args: {select: {population: boolean; id?: boolean}})=>args.select.id ? db.lockedFind(args) : db.baseline(args), update:db.update}, source:{findFirst:db.source}, auditLog:{create:db.audit}};
const now=new Date('2026-01-01T00:00:00Z');
let row: Record<string, unknown>; let app: Express;
beforeAll(async()=>{vi.stubEnv('NODE_ENV','test');vi.stubEnv('LOG_LEVEL','silent');vi.stubEnv('DATABASE_URL','postgresql://user:pass@localhost:5432/db');vi.stubEnv('REDIS_URL','redis://localhost:6379');vi.stubEnv('JWT_ACCESS_SECRET',secret);vi.stubEnv('RATE_LIMIT_ENABLED','false');app=(await import('../src/app.js')).createApp();});
beforeEach(()=>{
 vi.resetAllMocks(); row={id,villageId,sourceId,population:100,referenceYear:2021,referenceDate:null,isEstimate:false,isPreferred:false,needsReview:false,notes:null,verificationStatus:'PENDING',version:2,createdById:actor,createdAt:now,updatedAt:now};
 db.find.mockImplementation(async()=>({...row})); db.lockedFind.mockImplementation(async()=>({...row}));
 db.baseline.mockResolvedValue(null);
 db.lock.mockImplementation(async (_q, value)=>[{id:value}]); db.source.mockResolvedValue({id:otherSource});
 db.transaction.mockImplementation(async fn=>fn(tx));
 db.update.mockImplementation(async ({data})=>{const defined=Object.fromEntries(Object.entries(data).filter(([,value])=>value!==undefined));const result={...row,...defined,version:3}; delete result.createdById; delete result.updatedById; return result;});
 db.audit.mockResolvedValue({id:'audit'});
});
function patch(body: unknown, role='EDITOR', subject=actor) {const token=jwt.sign({role},secret,{subject,algorithm:'HS256'});return request(app).patch(`/api/v1/population-records/${id}`).set('Authorization',`Bearer ${token}`).send(body);}
describe('population PATCH',()=>{
 it.each([['EDITOR','PENDING',200],['EDITOR','VERIFIED',403],['EDITOR','REJECTED',403],['REVIEWER','PENDING',200],['REVIEWER','VERIFIED',200],['REVIEWER','REJECTED',403],['ADMIN','PENDING',200],['ADMIN','VERIFIED',200],['ADMIN','REJECTED',403]])('%s with %s returns %i',async(role,status,expected)=>{row.verificationStatus=status;const res=await patch({expectedVersion:2,population:200},role);expect(res.status).toBe(expected);if(expected===200){expect(res.body.data.verificationStatus).toBe(status);expect(db.audit).toHaveBeenCalledOnce();expect(db.update.mock.calls[0][0].data).not.toHaveProperty('verificationStatus');expect(res.body.data).not.toHaveProperty('createdById');}});
 it('denies an editor editing another creator',async()=>{row.createdById=null;expect((await patch({expectedVersion:2,population:200})).status).toBe(403);expect(db.update).not.toHaveBeenCalled();});
 it.each([{}, {expectedVersion:2}, {expectedVersion:0,population:1}, {expectedVersion:2,isPreferred:true}, {expectedVersion:2,needsReview:false}, {expectedVersion:2,needsReview:true}, {expectedVersion:2,verificationStatus:'VERIFIED'}, {expectedVersion:2,population:0}, {expectedVersion:2,referenceYear:2101}, {expectedVersion:2,notes:'x'.repeat(5001)}])('rejects invalid input %j',async body=>{expect((await patch(body)).status).toBe(400);expect(db.transaction).not.toHaveBeenCalled();});
 it.each([[151,true],[49,true],[150,false],[50,false],[149,false],[51,false]])('calculates anomaly for %i',async(population,expected)=>{row.population=90;db.baseline.mockResolvedValue({population:100});const res=await patch({expectedVersion:2,population});expect(res.status).toBe(200);expect(res.body.data.needsReview).toBe(expected);expect(db.update.mock.calls[0][0].data.needsReview).toBe(expected);expect(db.audit.mock.calls[0][0].data.after.needsReview).toBe(expected);});
 it('excludes the edited record from the latest verified baseline after authorization and version checks',async()=>{row.verificationStatus='VERIFIED';db.baseline.mockResolvedValue({population:100});expect((await patch({expectedVersion:2,population:151},'REVIEWER')).status).toBe(200);expect(db.baseline).toHaveBeenCalledWith({where:{villageId,verificationStatus:'VERIFIED',deletedAt:null,id:{not:id}},orderBy:[{referenceYear:'desc'},{id:'asc'}],select:{population:true}});expect(db.lockedFind.mock.invocationCallOrder[0]).toBeLessThan(db.baseline.mock.invocationCallOrder[0]!);expect(db.baseline.mock.invocationCallOrder[0]).toBeLessThan(db.update.mock.invocationCallOrder[0]!);});
 it.each([null,{population:0},{population:-1}])('handles baseline %j',async baseline=>{db.baseline.mockResolvedValue(baseline);const res=await patch({expectedVersion:2,population:200});expect(res.body.data.needsReview).toBe(baseline!==null);});
 it('keeps an existing flag when population changes without an anomaly',async()=>{row.needsReview=true;db.baseline.mockResolvedValue({population:100});const res=await patch({expectedVersion:2,population:110});expect(res.body.data.needsReview).toBe(true);expect(db.audit.mock.calls[0][0].data.after.needsReview).toBe(true);});
 it.each([{referenceYear:2020},{notes:'new'}])('preserves a flag for non-population change %j',async changes=>{row.needsReview=true;const res=await patch({expectedVersion:2,...changes});expect(res.body.data.needsReview).toBe(true);expect(db.baseline).not.toHaveBeenCalled();expect(db.update.mock.calls[0][0].data).not.toHaveProperty('needsReview');});
 it('does not query the baseline for forbidden, stale, or no-op changes',async()=>{expect((await patch({expectedVersion:2,population:200},'EDITOR','66666666-6666-4666-8666-666666666666')).status).toBe(403);expect((await patch({expectedVersion:1,population:200})).status).toBe(409);expect((await patch({expectedVersion:2,population:100})).status).toBe(200);expect(db.baseline).not.toHaveBeenCalled();expect(db.update).not.toHaveBeenCalled();expect(db.audit).not.toHaveBeenCalled();});
 it('does not forward an unexpected client flag through the repository',async()=>{const {populationRepository}=await import('../src/modules/population/population.repository.js');await populationRepository.update(id,{expectedVersion:2,notes:'new',needsReview:false} as never,actor,tx as never);expect(db.update.mock.calls[0][0].data).not.toHaveProperty('needsReview');});
 it('authenticates before validation',async()=>{expect((await request(app).patch(`/api/v1/population-records/${id}`).send({})).status).toBe(401);});
 it('locks the row and returns a no-op without audit or version increment',async()=>{const res=await patch({expectedVersion:2,population:100});expect(res.status).toBe(200);expect(res.body.data.version).toBe(2);expect(db.update).not.toHaveBeenCalled();expect(db.audit).not.toHaveBeenCalled();expect((db.lock.mock.calls[1][0] as TemplateStringsArray).join('')).toContain('FOR UPDATE');});
 it('rejects stale versions and concurrent changes even for no-ops',async()=>{row.version=3;expect((await patch({expectedVersion:2,population:100})).status).toBe(409);expect(db.update).not.toHaveBeenCalled();});
 it('rejects source changes between initial lookup and row lock',async()=>{db.lockedFind.mockImplementationOnce(async()=>({...row,sourceId:otherSource}));expect((await patch({expectedVersion:2,population:100})).status).toBe(409);expect(db.update).not.toHaveBeenCalled();expect(db.audit).not.toHaveBeenCalled();});
 it('treats equivalent timestamps as a no-op and supports clearing dates',async()=>{row.referenceDate=new Date('2020-01-01T00:00:00Z');expect((await patch({expectedVersion:2,referenceDate:'2020-01-01T02:00:00+02:00'})).status).toBe(200);expect(db.update).not.toHaveBeenCalled();expect((await patch({expectedVersion:2,referenceDate:null})).status).toBe(200);expect(db.update.mock.calls[0][0].data.referenceDate).toBeNull();});
 it.each([['EDITOR','PENDING'],['REVIEWER','PENDING'],['REVIEWER','VERIFIED'],['ADMIN','PENDING'],['ADMIN','VERIFIED']])('allows %s to change a preferred %s year with audit',async(role,status)=>{row.isPreferred=true;row.verificationStatus=status;const res=await patch({expectedVersion:2,referenceYear:2020},role);expect(res.status).toBe(200);expect(res.body.data).toMatchObject({referenceYear:2020,isPreferred:true,verificationStatus:status,version:3});expect(db.update.mock.calls[0][0].where.version).toBe(2);expect(db.audit.mock.calls[0][0].data).toMatchObject({before:{referenceYear:2021,version:2},after:{referenceYear:2020,version:3}});});
 it('checks version before a preferred year change or no-op',async()=>{row.isPreferred=true;for(const referenceYear of [2020,2021]) expect((await patch({expectedVersion:1,referenceYear},'REVIEWER')).status).toBe(409);expect(db.update).not.toHaveBeenCalled();expect(db.audit).not.toHaveBeenCalled();expect((await patch({expectedVersion:2,referenceYear:2021},'REVIEWER')).status).toBe(200);expect(db.update).not.toHaveBeenCalled();expect(db.audit).not.toHaveBeenCalled();});
 it('only maps explicitly identified preferred-index conflicts',async()=>{row.isPreferred=true;const error=(target:unknown,modelName='PopulationRecord')=>new Prisma.PrismaClientKnownRequestError('unique',{code:'P2002',clientVersion:'6.19.3',meta:{modelName,target}});db.update.mockRejectedValueOnce(error('population_records_one_preferred_per_year_idx'));expect((await patch({expectedVersion:2,referenceYear:2020},'REVIEWER')).status).toBe(409);for(const target of [['village_id','reference_year'],['population_records_one_preferred_per_year_idx'],'other_index',undefined]){db.update.mockRejectedValueOnce(error(target));expect((await patch({expectedVersion:2,referenceYear:2020},'REVIEWER')).status).toBe(500);}db.update.mockRejectedValueOnce(error('population_records_one_preferred_per_year_idx','OtherModel'));expect((await patch({expectedVersion:2,referenceYear:2020},'REVIEWER')).status).toBe(500);expect(db.audit).not.toHaveBeenCalled();});
 it('retains an unchanged source without checking its active status',async()=>{expect((await patch({expectedVersion:2,sourceId,population:200})).status).toBe(200);expect(db.source).not.toHaveBeenCalled();});
 it('locks village then changed source then population and audits persisted changes',async()=>{const res=await patch({expectedVersion:2,sourceId:otherSource,notes:' hi '});expect(res.status).toBe(200);expect(db.lock.mock.calls.map(call=>(call[0] as TemplateStringsArray).join(''))).toEqual([expect.stringContaining('FROM villages'),expect.stringContaining('FROM sources'),expect.stringContaining('FROM population_records')]);expect(db.audit.mock.calls[0][0].data).toMatchObject({action:'UPDATE',actorId:actor,before:{sourceId,notes:null,version:2},after:{sourceId:otherSource,notes:'hi',version:3}});});
 it('returns 404 when a replacement source is not active',async()=>{db.lock.mockResolvedValueOnce([{id:villageId}]).mockResolvedValueOnce([]);expect((await patch({expectedVersion:2,sourceId:otherSource})).status).toBe(404);expect(db.update).not.toHaveBeenCalled();});
 it.each([
  ['another creator', 'missing', {createdById:'66666666-6666-4666-8666-666666666666'}, 403],
  ['forbidden status', 'missing', {verificationStatus:'VERIFIED'}, 403],
  ['another creator', 'soft-deleted', {createdById:'66666666-6666-4666-8666-666666666666'}, 403],
  ['authorized editor', 'missing', {}, 404],
  ['authorized editor', 'soft-deleted', {}, 404],
 ])('%s with a %s replacement source gets the appropriate response',async(_description, _sourceState, changes, expected)=>{
  Object.assign(row,changes);
  // Both missing and soft-deleted sources are excluded by the active-source lock query.
  db.lock.mockImplementation(async (query, value)=>{
   if ((query as TemplateStringsArray).join('').includes('FROM sources')) {
    expect((query as TemplateStringsArray).join('')).toContain('deleted_at IS NULL');
    return [];
   }
   return [{id:value}];
  });
  const response=await patch({expectedVersion:2,sourceId:otherSource});
  expect(response.status).toBe(expected);
  expect(db.lockedFind).toHaveBeenCalledOnce();
  expect(db.update).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled();
 });
 it.each([{createdById:'66666666-6666-4666-8666-666666666666'},{verificationStatus:'VERIFIED'}])('rechecks changed authorization on the locked record: %j',async changes=>{
  db.lockedFind.mockImplementationOnce(async()=>({...row,...changes}));
  expect((await patch({expectedVersion:2,sourceId:otherSource})).status).toBe(403);
  expect(db.lockedFind).toHaveBeenCalledOnce(); expect(db.update).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled();
 });
 it('checks locked authorization before reporting a missing source after a concurrent ownership change',async()=>{
  db.lock.mockResolvedValueOnce([{id:villageId}]).mockResolvedValueOnce([]);
  db.lockedFind.mockImplementationOnce(async()=>({...row,createdById:'66666666-6666-4666-8666-666666666666'}));
  expect((await patch({expectedVersion:2,sourceId:otherSource})).status).toBe(403);
  expect(db.update).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled();
 });
 it('returns 404 for missing records and 409 on conditional race',async()=>{db.find.mockResolvedValueOnce(null);expect((await patch({expectedVersion:2,population:200})).status).toBe(404);db.update.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('gone',{code:'P2025',clientVersion:'6.19.3'}));expect((await patch({expectedVersion:2,population:200})).status).toBe(409);});
 it('only translates recognized business-key uniqueness errors',async()=>{const error=(target:string[])=>new Prisma.PrismaClientKnownRequestError('unique',{code:'P2002',clientVersion:'6.19.3',meta:{modelName:'PopulationRecord',target}});db.update.mockRejectedValueOnce(error(['village_id','reference_year','source_id']));expect((await patch({expectedVersion:2,population:200})).status).toBe(409);db.update.mockRejectedValueOnce(error(['id']));expect((await patch({expectedVersion:2,population:200})).status).toBe(500);});
 it('propagates audit failures from the transaction',async()=>{db.audit.mockRejectedValue(new Error('audit failure'));expect((await patch({expectedVersion:2,population:200})).status).toBe(500);expect(db.update).toHaveBeenCalledOnce();expect(db.audit).toHaveBeenCalledOnce();});
});
