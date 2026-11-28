import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const db=vi.hoisted(()=>({find:vi.fn(),locked:vi.fn(),lock:vi.fn(),source:vi.fn(),create:vi.fn(),audit:vi.fn(),transaction:vi.fn(),populationUpdate:vi.fn()}));
vi.mock('../src/shared/db.js',()=>({prisma:{populationRecord:{findFirst:db.find},$transaction:db.transaction}}));
vi.mock('../src/shared/cache.js',()=>({redis:{}}));
const id='11111111-1111-4111-8111-111111111111',villageId='22222222-2222-4222-8222-222222222222',sourceId='33333333-3333-4333-8333-333333333333',otherSource='44444444-4444-4444-8444-444444444444',actor='55555555-5555-4555-8555-555555555555',requestId='change-request-test';
const secret='test-secret-with-at-least-32-characters';
const now=new Date('2026-01-01T00:00:00Z');
const tx={$queryRaw:db.lock,populationRecord:{findFirst:(args: {select: {createdById?: boolean}})=>args.select.createdById ? db.locked(args) : db.find(args),update:db.populationUpdate},source:{findFirst:db.source},changeRequest:{create:db.create},auditLog:{create:db.audit}};
let row:Record<string,unknown>,app:Express;
const body={entityType:'PopulationRecord',entityId:id,baseVersion:3,proposedChanges:{population:150},reason:' census '};
beforeAll(async()=>{vi.stubEnv('NODE_ENV','test');vi.stubEnv('LOG_LEVEL','silent');vi.stubEnv('DATABASE_URL','postgresql://user:pass@localhost:5432/db');vi.stubEnv('REDIS_URL','redis://localhost:6379');vi.stubEnv('JWT_ACCESS_SECRET',secret);vi.stubEnv('RATE_LIMIT_ENABLED','false');app=(await import('../src/app.js')).createApp();});
beforeEach(()=>{
 vi.resetAllMocks(); row={id,villageId,sourceId,population:100,referenceYear:2020,referenceDate:now,isEstimate:false,isPreferred:true,needsReview:true,notes:null,verificationStatus:'VERIFIED',version:3,createdById:'another',createdAt:now,updatedAt:now};
 db.find.mockImplementation(async()=>({...row}));db.locked.mockImplementation(async()=>({...row}));db.lock.mockImplementation(async (_query:TemplateStringsArray,value:string)=>[{id:value}]);db.source.mockResolvedValue({id:otherSource});
 db.transaction.mockImplementation(async(fn:(client:typeof tx)=>unknown)=>fn(tx));
 db.create.mockImplementation(async({data}:{data:Record<string,unknown>})=>({id:'66666666-6666-4666-8666-666666666666',...data,reason:data.reason??null,reviewedById:null,reviewComment:null,reviewedAt:null,createdAt:now,updatedAt:now}));db.audit.mockResolvedValue({});
});
function post(payload:object=body,role?:string){let req=request(app).post('/api/v1/change-requests').set('X-Request-Id',requestId);if(role)req=req.set('Authorization',`Bearer ${jwt.sign({role},secret,{subject:actor})}`);return req.send(payload);}
describe('change request submission',()=>{
 it('creates and audits a normalized proposal in the same transaction without Population writes',async()=>{
  const res=await post(body,'EDITOR');expect(res.status).toBe(201);expect(res.body.data).toMatchObject({entityType:'PopulationRecord',entityId:id,baseVersion:3,reason:'census',proposedChanges:{population:150},status:'PENDING',requestedById:actor});
  expect(db.audit.mock.calls[0]![0].data).toMatchObject({entityType:'ChangeRequest',action:'CREATE',actorId:actor,requestId,after:{proposedChanges:{population:150}}});expect(db.create).toHaveBeenCalledOnce();expect(db.populationUpdate).not.toHaveBeenCalled();
  expect(db.lock.mock.calls.map(call=>(call[0] as TemplateStringsArray).join(''))).toEqual([expect.stringContaining('FROM villages'),expect.stringContaining('FROM population_records')]);
 });
 it('authenticates and authorizes before validation and lookup',async()=>{expect((await post({},undefined)).status).toBe(401);for(const role of ['REVIEWER','ADMIN'])expect((await post({},role)).status).toBe(403);expect(db.find).not.toHaveBeenCalled();});
 it('denies non-editors at the service boundary',async()=>{const {changeRequestsService}=await import('../src/modules/change-requests/change-requests.service.js');await expect(changeRequestsService.submit({...body,entityType:'PopulationRecord'}, {actorId:actor,role:'ADMIN',requestId})).rejects.toMatchObject({statusCode:403});expect(db.transaction).not.toHaveBeenCalled();});
 it.each([{entityType:'Village'},{entityId:'bad'},{baseVersion:0},{baseVersion:2147483648},{proposedChanges:{}},...['expectedVersion','version','isPreferred','needsReview','status','verifiedById','verifiedAt','updatedById','deletedAt','requestedById','reviewedById'].map(key=>({proposedChanges:{[key]:null}})),{proposedChanges:{population:1,extra:1}},{extra:true}])('rejects invalid payload %j',async changes=>{expect((await post({...body,...changes},'EDITOR')).status).toBe(400);expect(db.find).not.toHaveBeenCalled();});
 it.each(['PENDING','REJECTED'])('rejects %s targets',async status=>{row.verificationStatus=status;expect((await post(body,'EDITOR')).status).toBe(409);expect(db.create).not.toHaveBeenCalled();});
 it('rejects missing target, inactive village, stale version, exhaustion, and no-op',async()=>{
  db.find.mockResolvedValueOnce(null);expect((await post(body,'EDITOR')).status).toBe(404);
  db.lock.mockResolvedValueOnce([]);expect((await post(body,'EDITOR')).status).toBe(404);
  expect((await post({...body,baseVersion:2},'EDITOR')).status).toBe(409);
  row.version=2147483647;expect((await post({...body,baseVersion:2147483647},'EDITOR')).status).toBe(409);
  row.version=3;expect((await post({...body,proposedChanges:{population:100}},'EDITOR')).status).toBe(400);
  expect(db.create).not.toHaveBeenCalled();expect(db.audit).not.toHaveBeenCalled();
 });
 it('locks a changed source before the record and rejects a missing replacement',async()=>{
  expect((await post({...body,proposedChanges:{sourceId:otherSource}},'EDITOR')).status).toBe(201);
  expect(db.lock.mock.calls.map(call=>(call[0] as TemplateStringsArray).join(''))).toEqual([expect.stringContaining('FROM villages'),expect.stringContaining('FROM sources'),expect.stringContaining('FROM population_records')]);
  db.lock.mockClear();db.lock.mockResolvedValueOnce([{id:villageId}]).mockResolvedValueOnce([]).mockResolvedValueOnce([{id}]);
  expect((await post({...body,proposedChanges:{sourceId:otherSource}},'EDITOR')).status).toBe(404);expect(db.create).toHaveBeenCalledTimes(1);
 });
 it('retains unchanged deleted source and handles null and equivalent date semantics',async()=>{
  expect((await post({...body,proposedChanges:{sourceId,notes:' new ',referenceDate:null}},'EDITOR')).status).toBe(201);expect(db.source).not.toHaveBeenCalled();expect(db.create.mock.calls[0]![0].data.proposedChanges).toEqual({sourceId,notes:'new',referenceDate:null});
  expect((await post({...body,proposedChanges:{referenceDate:'2026-01-01T02:00:00+02:00'}},'EDITOR')).status).toBe(400);
  expect((await post({...body,proposedChanges:{referenceDate:'2026-01-02T02:00:00+02:00'}},'EDITOR')).status).toBe(201);
  expect(db.create.mock.calls[1]![0].data.proposedChanges.referenceDate).toBe('2026-01-02T02:00:00+02:00');
 });
 it('allows multiple requests and propagates audit failure',async()=>{
  expect((await post(body,'EDITOR')).status).toBe(201);expect((await post(body,'EDITOR')).status).toBe(201);expect(db.create).toHaveBeenCalledTimes(2);
  db.audit.mockRejectedValueOnce(new Error('audit failure'));expect((await post(body,'EDITOR')).status).toBe(500);expect(db.transaction).toHaveBeenCalledTimes(3);expect(db.populationUpdate).not.toHaveBeenCalled();
 });
 it.each(['active','deleted'])('treats equivalent UUID as unchanged for an %s source',async state=>{
  const canonical='abcdefab-cdef-4abc-8def-abcdefabcdef'; row.sourceId=canonical;
  if(state==='deleted') db.source.mockResolvedValue(null);
  const res=await post({...body,proposedChanges:{sourceId:canonical.toUpperCase()}},'EDITOR');
  expect(res.status).toBe(400); expect(res.body.error.code).toBe('VALIDATION_ERROR');
  expect(db.source).not.toHaveBeenCalled(); expect(db.lock.mock.calls.map(call=>(call[0] as TemplateStringsArray).join(''))).toEqual([expect.stringContaining('FROM villages'),expect.stringContaining('FROM population_records')]);
  expect(db.create).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled();
 });
 it('stores canonical UUID alongside another change without source lookup',async()=>{
  const canonical='abcdefab-cdef-4abc-8def-abcdefabcdef'; row.sourceId=canonical;
  const res=await post({...body,proposedChanges:{sourceId:canonical.toUpperCase(),isEstimate:true}},'EDITOR');
  expect(res.status).toBe(201); expect(res.body.data.proposedChanges).toEqual({sourceId:canonical,isEstimate:true});
  expect(db.source).not.toHaveBeenCalled(); expect(db.lock).toHaveBeenCalledTimes(2);
 });
 it.each([['deleted',404],['active',201]] as const)('validates a distinct %s source',async(state,status)=>{
  if(state==='deleted') db.lock.mockImplementation(async(query:TemplateStringsArray,value:string)=>(query.join('').includes('FROM sources')?[]:[{id:value}]));
  expect((await post({...body,proposedChanges:{sourceId:otherSource}},'EDITOR')).status).toBe(status);
  expect(db.lock.mock.calls.map(call=>(call[0] as TemplateStringsArray).join(''))).toEqual([expect.stringContaining('FROM villages'),expect.stringContaining('FROM sources'),expect.stringContaining('FROM population_records')]);
 });
 it.each([
  ['deleted',null,404],['village',{villageId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},409],
  ['source',{sourceId:otherSource},409],['status',{verificationStatus:'PENDING'},409],['version',{version:4},409],
 ] as const)('rejects a target whose locked %s differs',async(_name,change,status)=>{
  db.locked.mockResolvedValueOnce(change===null?null:{...row,...change});
  expect((await post(body,'EDITOR')).status).toBe(status); expect(db.create).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled(); expect(db.populationUpdate).not.toHaveBeenCalled();
 });
 it('preserves false, null, and date JSON for revalidation',async()=>{
  row.isEstimate=true; const proposal={isEstimate:false,notes:null,referenceDate:'2026-01-02T02:00:00+02:00'};
  const response=await post({...body,proposedChanges:proposal},'EDITOR'); expect(response.status).toBe(201);
  const stored=JSON.parse(JSON.stringify(db.create.mock.calls[0]![0].data.proposedChanges));
  const {updatePopulationSchema}=await import('../src/modules/population/population.schemas.js');
  expect(updatePopulationSchema.parse({expectedVersion:3,...stored})).toEqual({expectedVersion:3,...proposal});
  expect(db.audit.mock.calls[0]![0].data.after.proposedChanges).toEqual(proposal);
 });
 it('passes the same transaction client to validation, creation, and audit',async()=>{
  const {populationService}=await import('../src/modules/population/population.service.js');
  const {populationRepository}=await import('../src/modules/population/population.repository.js');
  const {changeRequestsRepository}=await import('../src/modules/change-requests/change-requests.repository.js');
  const auditService=await import('../src/modules/audit/audit.service.js');
  const validate=vi.spyOn(populationService,'validateChangeProposal');
  const lookup=vi.spyOn(populationRepository,'findById');
  const create=vi.spyOn(changeRequestsRepository,'create');
  const audit=vi.spyOn(auditService,'recordAudit');
  try {
   expect((await post(body,'EDITOR')).status).toBe(201);
   expect(validate.mock.calls[0]![2]).toBe(tx); expect(lookup.mock.calls[0]![1]).toBe(tx); expect(create.mock.calls[0]![2]).toBe(tx); expect(audit.mock.calls[0]![1]).toBe(tx);
  } finally {validate.mockRestore();lookup.mockRestore();create.mockRestore();audit.mockRestore();}
 });
});
