import type { ChangeRequest } from '@prisma/client';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const db=vi.hoisted(()=>({transaction:vi.fn(),lock:vi.fn(),find:vi.fn(),update:vi.fn(),audit:vi.fn()}));
vi.mock('../src/shared/db.js',()=>({prisma:{$transaction:db.transaction}}));
vi.mock('../src/shared/cache.js',()=>({redis:{}}));
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', actor='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', requester='cccccccc-cccc-4ccc-8ccc-cccccccccccc', secret='test-secret-with-at-least-32-characters';
const now=new Date('2026-01-01T00:00:00Z');
const tx={$queryRaw:db.lock,changeRequest:{findUnique:db.find,update:db.update},auditLog:{create:db.audit}};
let app:Express,row:ChangeRequest;
let apply:ReturnType<typeof vi.spyOn>;
beforeAll(async()=>{
 vi.stubEnv('NODE_ENV','test');vi.stubEnv('LOG_LEVEL','silent');vi.stubEnv('DATABASE_URL','postgresql://user:pass@localhost:5432/db');vi.stubEnv('REDIS_URL','redis://localhost:6379');vi.stubEnv('JWT_ACCESS_SECRET',secret);vi.stubEnv('RATE_LIMIT_ENABLED','false');
 app=(await import('../src/app.js')).createApp();
 const {populationService}=await import('../src/modules/population/population.service.js');
 apply=vi.spyOn(populationService,'applyApprovedChange');
});
afterAll(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(()=>{
 vi.resetAllMocks();row={id,entityType:'PopulationRecord',entityId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',baseVersion:3,proposedChanges:{notes:'updated'},reason:null,status:'PENDING',requestedById:requester,reviewedById:null,reviewComment:null,createdAt:now,updatedAt:now,reviewedAt:null};
 db.transaction.mockImplementation(async(fn:(client:typeof tx)=>unknown)=>fn(tx));db.lock.mockResolvedValue([{id}]);db.find.mockImplementation(async()=>({...row}));db.update.mockImplementation(async({data}:{data:Partial<ChangeRequest>})=>({...row,...data}));db.audit.mockResolvedValue({});
 apply.mockResolvedValue({before:{version:3},after:{version:4}});
});
function post(body:object={},role?:string,path=id){let req=request(app).post(`/api/v1/change-requests/${path}/approve`);if(role)req=req.set('Authorization',`Bearer ${jwt.sign({role},secret,{subject:actor})}`);return req.send(body);}
describe('change request approval',()=>{
 it('authenticates and authorizes before lookup',async()=>{expect((await post({},undefined)).status).toBe(401);expect((await post({},'EDITOR')).status).toBe(403);expect(db.transaction).not.toHaveBeenCalled();});
 it('rejects an editor at the service boundary before opening a transaction',async()=>{const {changeRequestsService}=await import('../src/modules/change-requests/change-requests.service.js');await expect(changeRequestsService.approve(id,{},{actorId:actor,role:'EDITOR',requestId:'service-test'})).rejects.toMatchObject({statusCode:403});expect(db.transaction).not.toHaveBeenCalled();});
 it.each([{reviewComment:''},{reviewComment:'  '},{reviewComment:null},{reviewComment:'x'.repeat(5001)},{baseVersion:3},{proposedChanges:{notes:'x'}},{reviewedById:actor}])('rejects invalid bodies %j',async body=>{expect((await post(body,'REVIEWER')).status).toBe(400);expect(db.transaction).not.toHaveBeenCalled();});
 it('rejects an invalid id',async()=>{expect((await post({},'ADMIN','bad')).status).toBe(400);});
 it.each(['REVIEWER','ADMIN'] as const)('approves as %s with the transaction and two audits',async role=>{
  const res=await post({reviewComment:' accepted '},role);
  expect(res.status).toBe(200);expect(res.body.data).toMatchObject({id,status:'APPROVED',reviewedById:actor,reviewComment:'accepted',reviewedAt:expect.any(String)});
  expect(apply).toHaveBeenCalledWith(row.entityId,3,{notes:'updated'},actor,tx);
  expect(db.update).toHaveBeenCalledWith({where:{id,status:'PENDING'},data:{status:'APPROVED',reviewedById:actor,reviewComment:'accepted',reviewedAt:expect.any(Date)}});
  expect(db.audit).toHaveBeenCalledTimes(2);expect(db.audit.mock.calls[0]![0].data).toMatchObject({entityType:'PopulationRecord',action:'UPDATE',actorId:actor,before:{version:3},after:{version:4}});expect(db.audit.mock.calls[1]![0].data).toMatchObject({entityType:'ChangeRequest',action:'APPROVE',actorId:actor,before:{status:'PENDING'},after:{status:'APPROVED'}});
 });
 it('accepts an omitted comment',async()=>{expect((await post({},'ADMIN')).status).toBe(200);expect(db.update.mock.calls[0]![0].data.reviewComment).toBeNull();});
 it.each(['REVIEWER','ADMIN'] as const)('rejects self approval by %s',async role=>{row.requestedById=actor.toUpperCase();expect((await post({},role)).status).toBe(403);expect(apply).not.toHaveBeenCalled();});
 it('returns 404 for a missing request',async()=>{db.lock.mockResolvedValueOnce([]);expect((await post({},'ADMIN')).status).toBe(404);});
 it.each(['APPROVED','REJECTED'] as const)('rejects %s requests',async status=>{row.status=status;expect((await post({},'ADMIN')).status).toBe(409);expect(apply).not.toHaveBeenCalled();});
 it.each([{},{isPreferred:true},{notes:3},{population:0}])('rejects invalid stored proposals %j',async proposal=>{row.proposedChanges=proposal;expect((await post({},'ADMIN')).status).toBe(409);expect(apply).not.toHaveBeenCalled();});
 it('rejects unsupported entities',async()=>{row.entityType='Village';expect((await post({},'ADMIN')).status).toBe(409);expect(apply).not.toHaveBeenCalled();});
 it('treats a malformed historical target id as missing',async()=>{row.entityId='not-a-uuid';expect((await post({},'ADMIN')).status).toBe(404);expect(apply).not.toHaveBeenCalled();});
 it('checks pending status before self-approval',async()=>{row.status='APPROVED';row.requestedById=actor;expect((await post({},'ADMIN')).status).toBe(409);expect(apply).not.toHaveBeenCalled();});
 it('propagates an audit failure',async()=>{db.audit.mockRejectedValueOnce(new Error('audit failure'));expect((await post({},'ADMIN')).status).toBe(500);});
 it('does not attempt request transition or audit if population application fails',async()=>{apply.mockRejectedValueOnce(new Error('population failure'));expect((await post({},'ADMIN')).status).toBe(500);expect(db.update).not.toHaveBeenCalled();expect(db.audit).not.toHaveBeenCalled();});
 it('does not attempt audits if the request transition fails',async()=>{db.update.mockRejectedValueOnce(new Error('transition failure'));expect((await post({},'ADMIN')).status).toBe(500);expect(db.audit).not.toHaveBeenCalled();});
 it('propagates a failure from the second audit',async()=>{db.audit.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('second audit failure'));expect((await post({},'ADMIN')).status).toBe(500);expect(db.audit).toHaveBeenCalledTimes(2);});
});
