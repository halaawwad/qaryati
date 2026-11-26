import { Prisma, type ChangeRequest } from '@prisma/client';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const db=vi.hoisted(()=>({transaction:vi.fn(),lock:vi.fn(),find:vi.fn(),update:vi.fn(),audit:vi.fn()}));
vi.mock('../src/shared/db.js',()=>({prisma:{$transaction:db.transaction}}));
vi.mock('../src/shared/cache.js',()=>({redis:{}}));
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',actor='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',requestId='reject-test',secret='test-secret-with-at-least-32-characters';
const now=new Date('2026-01-01T00:00:00Z');
const tx={$queryRaw:db.lock,changeRequest:{findUnique:db.find,update:db.update},auditLog:{create:db.audit}};
let app:Express,row:ChangeRequest;
beforeAll(async()=>{vi.stubEnv('NODE_ENV','test');vi.stubEnv('LOG_LEVEL','silent');vi.stubEnv('DATABASE_URL','postgresql://user:pass@localhost:5432/db');vi.stubEnv('REDIS_URL','redis://localhost:6379');vi.stubEnv('JWT_ACCESS_SECRET',secret);vi.stubEnv('RATE_LIMIT_ENABLED','false');app=(await import('../src/app.js')).createApp();});
beforeEach(()=>{
 vi.resetAllMocks(); row={id,entityType:'PopulationRecord',entityId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',baseVersion:3,proposedChanges:{notes:null},reason:'reason',status:'PENDING',requestedById:actor,reviewedById:null,reviewComment:null,createdAt:now,updatedAt:now,reviewedAt:null};
 db.transaction.mockImplementation(async(fn:(client:typeof tx)=>unknown)=>fn(tx));db.lock.mockResolvedValue([{id}]);db.find.mockImplementation(async()=>({...row}));
 db.update.mockImplementation(async({data}:{data:Partial<ChangeRequest>})=>({...row,...data}));db.audit.mockResolvedValue({});
});
function post(body:object={reviewComment:' reject reason '},role?:string,path=id){let req=request(app).post(`/api/v1/change-requests/${path}/reject`).set('X-Request-Id',requestId);if(role)req=req.set('Authorization',`Bearer ${jwt.sign({role},secret,{subject:actor})}`);return req.send(body);}
describe('change request rejection',()=>{
 it('authenticates and authorizes before validation or lookup',async()=>{expect((await post({},undefined,'bad')).status).toBe(401);expect((await post({},'EDITOR','bad')).status).toBe(403);expect(db.transaction).not.toHaveBeenCalled();expect(db.lock).not.toHaveBeenCalled();});
 it('rejects editor service calls before lookup',async()=>{const {changeRequestsService}=await import('../src/modules/change-requests/change-requests.service.js');await expect(changeRequestsService.reject(id,{reviewComment:'x'},{actorId:actor,role:'EDITOR',requestId})).rejects.toMatchObject({statusCode:403});expect(db.transaction).not.toHaveBeenCalled();});
 it.each([{}, {reviewComment:null},{reviewComment:''},{reviewComment:'   '},{reviewComment:123},{reviewComment:'x'.repeat(5001)},{reviewComment:'x',status:'REJECTED'},{reviewComment:'x',reviewedById:actor},{reviewComment:'x',reviewedAt:now.toISOString()},{reviewComment:'x',requestedById:actor},{reviewComment:'x',proposedChanges:{}},{reviewComment:'x',baseVersion:2}])('rejects invalid body %j',async body=>{expect((await post(body,'REVIEWER')).status).toBe(400);expect(db.transaction).not.toHaveBeenCalled();});
 it('rejects invalid UUID',async()=>{expect((await post({reviewComment:'x'},'ADMIN','bad')).status).toBe(400);expect(db.transaction).not.toHaveBeenCalled();});
 it.each(['REVIEWER','ADMIN'] as const)('rejects as %s and audits the locked transition',async role=>{
  const res=await post({reviewComment:' reason '},role);expect(res.status).toBe(200);expect(res.body.data).toMatchObject({id,status:'REJECTED',reviewedById:actor,reviewComment:'reason',reviewedAt:expect.any(String),requestedById:actor,entityId:row.entityId,baseVersion:3,proposedChanges:{notes:null},reason:'reason'});
  expect((db.lock.mock.calls[0]![0] as TemplateStringsArray).join('')).toContain('FOR UPDATE');expect(db.lock.mock.calls[0]![1]).toBe(id);expect(db.find).toHaveBeenCalledWith({where:{id}});
  expect(db.update.mock.calls[0]![0]).toEqual({where:{id,status:'PENDING'},data:{status:'REJECTED',reviewedById:actor,reviewComment:'reason',reviewedAt:expect.any(Date)}});
  expect(db.audit).toHaveBeenCalledOnce();expect(db.audit.mock.calls[0]![0].data).toMatchObject({entityType:'ChangeRequest',entityId:id,action:'REJECT',actorId:actor,requestId,before:{status:'PENDING',proposedChanges:{notes:null},requestedById:actor,reviewedAt:null},after:{status:'REJECTED',reviewedById:actor,reviewComment:'reason',reviewedAt:expect.any(String),baseVersion:3}});
 });
 it('uses the same transaction client for lock, update, and audit',async()=>{
  const {changeRequestsRepository}=await import('../src/modules/change-requests/change-requests.repository.js');const auditModule=await import('../src/modules/audit/audit.service.js');
  const lock=vi.spyOn(changeRequestsRepository,'lockById'),update=vi.spyOn(changeRequestsRepository,'reject'),audit=vi.spyOn(auditModule,'recordAudit');
  try{expect((await post({reviewComment:'x'},'ADMIN')).status).toBe(200);expect(lock.mock.calls[0]![1]).toBe(tx);expect(update.mock.calls[0]![3]).toBe(tx);expect(audit.mock.calls[0]![1]).toBe(tx);}finally{lock.mockRestore();update.mockRestore();audit.mockRestore();}
 });
 it('returns 404 for missing locked rows',async()=>{db.lock.mockResolvedValueOnce([]);expect((await post({reviewComment:'x'},'ADMIN')).status).toBe(404);expect(db.find).not.toHaveBeenCalled();expect(db.update).not.toHaveBeenCalled();expect(db.audit).not.toHaveBeenCalled();});
 it('returns 404 if locked row cannot be reloaded',async()=>{db.find.mockResolvedValueOnce(null);expect((await post({reviewComment:'x'},'ADMIN')).status).toBe(404);expect(db.update).not.toHaveBeenCalled();});
 it.each(['APPROVED','REJECTED'] as const)('rejects locked %s status without mutation',async status=>{db.find.mockResolvedValueOnce({...row,status});expect((await post({reviewComment:'x'},'ADMIN')).status).toBe(409);expect(db.update).not.toHaveBeenCalled();expect(db.audit).not.toHaveBeenCalled();});
 it('maps guarded update miss to conflict without audit',async()=>{db.update.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('missing',{code:'P2025',clientVersion:'6.19.3'}));expect((await post({reviewComment:'x'},'ADMIN')).status).toBe(409);expect(db.audit).not.toHaveBeenCalled();});
 it('permits historical and stale proposals without Population or Sources access',async()=>{row.entityId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';row.baseVersion=2147483647;expect((await post({reviewComment:'x'},'REVIEWER')).status).toBe(200);expect(db.lock).toHaveBeenCalledOnce();expect((db.lock.mock.calls[0]![0] as TemplateStringsArray).join('')).toContain('change_requests');});
 it('propagates audit failures and unexpected database errors',async()=>{db.audit.mockRejectedValueOnce(new Error('audit failure'));expect((await post({reviewComment:'x'},'ADMIN')).status).toBe(500);db.update.mockRejectedValueOnce(new Error('database failure'));expect((await post({reviewComment:'x'},'ADMIN')).status).toBe(500);expect(db.audit).toHaveBeenCalledTimes(1);});
});
