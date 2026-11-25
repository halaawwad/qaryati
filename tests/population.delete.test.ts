import { Prisma, type PopulationRecord } from '@prisma/client';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({find: vi.fn(), locked: vi.fn(), lock: vi.fn(), update: vi.fn(), count: vi.fn(), findMany: vi.fn(), village: vi.fn(), source: vi.fn(), audit: vi.fn(), transaction: vi.fn()}));
vi.mock('../src/shared/db.js', () => ({prisma: {populationRecord: {findFirst: db.find}, village: {findFirst: db.village}, $transaction: db.transaction}}));
vi.mock('../src/shared/cache.js', () => ({redis: {}}));
const id = '11111111-1111-4111-8111-111111111111', villageId = '22222222-2222-4222-8222-222222222222', sourceId = '33333333-3333-4333-8333-333333333333', actor = '55555555-5555-4555-8555-555555555555';
const secret = 'test-secret-with-at-least-32-characters';
const tx = {$queryRaw: db.lock, populationRecord: {findFirst: db.locked, update: db.update, count: db.count, findMany: db.findMany}, source: {findFirst: db.source}, auditLog: {create: db.audit}};
let row: PopulationRecord; let app: Express;
beforeAll(async () => {vi.stubEnv('NODE_ENV','test'); vi.stubEnv('LOG_LEVEL','silent'); vi.stubEnv('DATABASE_URL','postgresql://user:pass@localhost:5432/db'); vi.stubEnv('REDIS_URL','redis://localhost:6379'); vi.stubEnv('JWT_ACCESS_SECRET',secret); vi.stubEnv('RATE_LIMIT_ENABLED','false'); app=(await import('../src/app.js')).createApp();});
beforeEach(() => {
 vi.resetAllMocks();
 row = {id, villageId, sourceId, population:100, referenceYear:2021, referenceDate:null, isEstimate:false, isPreferred:true, needsReview:true, notes:'provenance', verificationStatus:'VERIFIED', verifiedById:actor, verifiedAt:new Date('2026-01-01T00:00:00Z'), version:3, createdById:'other', updatedById:'other', createdAt:new Date('2025-01-01T00:00:00Z'), updatedAt:new Date('2025-02-01T00:00:00Z'), deletedAt:null};
 db.find.mockImplementation(async () => ({...row})); db.locked.mockImplementation(async () => ({...row}));
 db.lock.mockImplementation(async (_query, value) => [{id:value}]); db.transaction.mockImplementation(async fn => fn(tx));
 db.village.mockResolvedValue({id:villageId});
 db.update.mockImplementation(async ({data}) => ({...row, ...data})); db.audit.mockResolvedValue({id:'audit'});
});
function del(role?: string, path = id) {let req=request(app).delete(`/api/v1/population-records/${path}`).set('x-request-id','delete-request'); if(role) req=req.set('Authorization',`Bearer ${jwt.sign({role},secret,{subject:actor,algorithm:'HS256'})}`); return req;}
describe('population DELETE', () => {
 it.each([[undefined,401],['EDITOR',403],['REVIEWER',403]] as const)('rejects %s before validation or lookup',async(role,status)=>{expect((await del(role,'bad')).status).toBe(status); expect(db.find).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled();});
 it('validates the UUID after authorization',async()=>{expect((await del('ADMIN','bad')).status).toBe(400); expect(db.find).not.toHaveBeenCalled();});
 it.each(['PENDING','VERIFIED','REJECTED'] as const)('deletes %s irrespective of ownership and preserves metadata and version',async status=>{
  row.verificationStatus=status; const response=await del('ADMIN'); expect(response.status).toBe(200);
  expect(response.body.data).toEqual({id,version:3,deletedAt:expect.any(String)});
  const write=db.update.mock.calls[0][0]; expect(write.where).toEqual({id,deletedAt:null});
  expect(write.data).toEqual({deletedAt:expect.any(Date),isPreferred:false,updatedById:actor});
  expect(db.update).toHaveBeenCalledOnce(); expect(db.audit).toHaveBeenCalledOnce();
  expect(db.audit.mock.calls[0][0].data).toMatchObject({entityType:'PopulationRecord',entityId:id,action:'DELETE',actorId:actor,requestId:'delete-request',before:{isPreferred:true,needsReview:true,version:3,verificationStatus:status,verifiedById:actor,verifiedAt:'2026-01-01T00:00:00.000Z',deletedAt:null,sourceId,notes:'provenance'},after:{isPreferred:false,needsReview:true,version:3,verificationStatus:status,verifiedById:actor,deletedAt:expect.any(String)}});
  expect(db.lock.mock.calls.map(call=>(call[0] as TemplateStringsArray).join(''))).toEqual([expect.stringContaining('FROM villages'),expect.stringContaining('FROM population_records')]);
  expect(db.update.mock.invocationCallOrder[0]).toBeLessThan(db.audit.mock.invocationCallOrder[0]!);
 });
 it('deletes non-preferred records and ignores unexpected bodies',async()=>{row.isPreferred=false; expect((await del('ADMIN').send({expectedVersion:999})).status).toBe(200); expect(db.update.mock.calls[0][0].data.isPreferred).toBe(false);});
 it('preserves provenance and audits the locked snapshots when the source is deleted',async()=>{
  const source = {id:sourceId, deletedAt:new Date('2026-02-01T00:00:00Z')};
  db.source.mockResolvedValue(source);
  const original = {...row};
  const prismaUpdatedAt = new Date('2026-11-25T10:00:01Z');
  let persisted = {...row};
  db.update.mockImplementationOnce(async ({data}) => {
   // Simulate Prisma's @updatedAt behavior; this does not test database persistence.
   persisted = {...persisted, ...data, updatedAt:prismaUpdatedAt};
   return {...persisted};
  });
  const response = await del('ADMIN');
  expect(response.status).toBe(200);
  const deletedAt = new Date(response.body.data.deletedAt);
  expect(persisted).toEqual({...original, deletedAt, updatedById:actor, updatedAt:prismaUpdatedAt, isPreferred:false});
  expect(db.source).not.toHaveBeenCalled();
  expect(db.lock.mock.calls.map(call=>(call[0] as TemplateStringsArray).join(''))).toEqual([
   expect.stringContaining('FROM villages'), expect.stringContaining('FROM population_records'),
  ]);
  expect(db.update).toHaveBeenCalledOnce();
  expect(db.update.mock.calls[0][0]).toMatchObject({where:{id,deletedAt:null},data:{deletedAt,isPreferred:false,updatedById:actor}});
  const snapshot = {id,villageId,sourceId,population:original.population,referenceYear:original.referenceYear,referenceDate:null,
   isEstimate:original.isEstimate,needsReview:original.needsReview,notes:original.notes,verificationStatus:original.verificationStatus,
   version:original.version,createdById:original.createdById,verifiedById:original.verifiedById,verifiedAt:original.verifiedAt?.toISOString()};
  expect(db.audit.mock.calls[0][0].data).toEqual({entityType:'PopulationRecord',entityId:id,action:'DELETE',actorId:actor,requestId:'delete-request',
   before:{...snapshot,updatedById:original.updatedById,isPreferred:true,deletedAt:null},
   after:{...snapshot,updatedById:actor,isPreferred:false,deletedAt:deletedAt.toISOString()}});
 });
 it('returns 404 for a missing or previously deleted record',async()=>{db.find.mockResolvedValue(null); expect((await del('ADMIN')).status).toBe(404); expect(db.update).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled();});
 it('returns 404 when the parent village becomes inactive',async()=>{db.lock.mockResolvedValueOnce([]); expect((await del('ADMIN')).status).toBe(404); expect(db.update).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled();});
 it('returns 404 when a concurrent delete wins or parent changes before the row lock',async()=>{db.lock.mockResolvedValueOnce([{id:villageId}]).mockResolvedValueOnce([]); expect((await del('ADMIN')).status).toBe(404); db.locked.mockResolvedValueOnce({...row,villageId:'other'}); expect((await del('ADMIN')).status).toBe(404); expect(db.update).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled();});
 it('maps a guarded write miss to 404 without audit',async()=>{db.update.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('missing',{code:'P2025',clientVersion:'6.19.3'})); expect((await del('ADMIN')).status).toBe(404); expect(db.audit).not.toHaveBeenCalled();});
 it('propagates audit failure through the transaction',async()=>{db.audit.mockRejectedValue(new Error('audit failed')); expect((await del('ADMIN')).status).toBe(500); expect(db.transaction).toHaveBeenCalledOnce(); expect(db.audit).toHaveBeenCalledOnce();});
 it('rolls back a staged delete when audit fails in the mocked transaction',async()=>{
  let committed = false;
  db.transaction.mockImplementation(async fn => {let staged=false; db.update.mockImplementationOnce(async ({data})=>{staged=true; return {...row,...data};}); try {const result=await fn(tx); committed=staged; return result;} catch (error) {throw error;}});
  db.audit.mockRejectedValue(new Error('audit failed')); expect((await del('ADMIN')).status).toBe(500); expect(committed).toBe(false);
 });
 it('allows only one successful delete and hides it from list and detail reads in the mock',async()=>{
  let deleted=false;
  db.find.mockImplementation(async ()=>deleted ? null : {...row});
  db.update.mockImplementation(async ({data})=>{deleted=true; return {...row,...data};});
  db.count.mockImplementation(async ({where})=>where.deletedAt === null && deleted ? 0 : 1);
  db.findMany.mockImplementation(async ({where})=>where.deletedAt === null && deleted ? [] : [row]);
  expect((await del('ADMIN')).status).toBe(200); expect((await del('ADMIN')).status).toBe(404);
  expect((await request(app).get(`/api/v1/population-records/${id}`)).status).toBe(404);
  const list=await request(app).get(`/api/v1/villages/${villageId}/population-records`);
  expect(list.status).toBe(200); expect(list.body.data).toEqual([]); expect(list.body.meta.total).toBe(0);
  expect(db.audit).toHaveBeenCalledOnce();
 });
 it.each(['EDITOR','REVIEWER'] as const)('rejects %s service calls before lookup',async role=>{const {populationService}=await import('../src/modules/population/population.service.js'); await expect(populationService.softDelete(id,{role,actorId:actor,requestId:'x'})).rejects.toMatchObject({statusCode:403}); expect(db.find).not.toHaveBeenCalled();});
});
