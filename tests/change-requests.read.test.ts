import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const db=vi.hoisted(()=>({transaction:vi.fn(),count:vi.fn(),findMany:vi.fn(),findFirst:vi.fn(),create:vi.fn(),audit:vi.fn()}));
vi.mock('../src/shared/db.js',()=>({prisma:{$transaction:db.transaction,changeRequest:{findFirst:db.findFirst}}}));
vi.mock('../src/shared/cache.js',()=>({redis:{}}));
const actor='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',id='cccccccc-cccc-4ccc-8ccc-cccccccccccc',target='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const secret='test-secret-with-at-least-32-characters';
const tx={changeRequest:{count:db.count,findMany:db.findMany,create:db.create},auditLog:{create:db.audit}};
const row={id,entityType:'PopulationRecord',entityId:target,baseVersion:3,proposedChanges:{notes:null},reason:null,status:'PENDING',requestedById:actor,reviewedById:null,reviewComment:null,reviewedAt:null,createdAt:new Date('2026-01-01Z'),updatedAt:new Date('2026-01-01Z')};
let app:Express;
beforeAll(async()=>{vi.stubEnv('NODE_ENV','test');vi.stubEnv('LOG_LEVEL','silent');vi.stubEnv('DATABASE_URL','postgresql://user:pass@localhost:5432/db');vi.stubEnv('REDIS_URL','redis://localhost:6379');vi.stubEnv('JWT_ACCESS_SECRET',secret);vi.stubEnv('RATE_LIMIT_ENABLED','false');app=(await import('../src/app.js')).createApp();});
beforeEach(()=>{vi.resetAllMocks();db.transaction.mockImplementation(async(fn:(client:typeof tx)=>unknown)=>fn(tx));db.count.mockResolvedValue(1);db.findMany.mockResolvedValue([row]);db.findFirst.mockResolvedValue(row);});
function get(path:string,role?:string){let req=request(app).get(path);if(role)req=req.set('Authorization',`Bearer ${jwt.sign({role},secret,{subject:actor})}`);return req;}
describe('change request reads',()=>{
 it('authenticates before validation and lookup and rejects an unsupported token role',async()=>{for(const path of ['/api/v1/change-requests?page=bad','/api/v1/change-requests/bad']){expect((await get(path)).status).toBe(401);expect((await get(path,'VISITOR')).status).toBe(401);}expect(db.transaction).not.toHaveBeenCalled();expect(db.findFirst).not.toHaveBeenCalled();});
 it('enforces editor ownership in both database queries with matching count and read filters',async()=>{
  const res=await get('/api/v1/change-requests','EDITOR');expect(res.status).toBe(200);expect(res.body.meta).toMatchObject({page:1,limit:20,total:1,totalPages:1,hasNextPage:false,hasPrevPage:false});
  const count=db.count.mock.calls[0]![0],read=db.findMany.mock.calls[0]![0];expect(count.where).toEqual(read.where);expect(read.where.requestedById).toBe(actor);expect(read).toMatchObject({skip:0,take:20,orderBy:[{createdAt:'desc'},{id:'asc'}]});expect(db.transaction.mock.calls[0]![1]).toEqual({isolationLevel:'RepeatableRead'});
  expect((await get(`/api/v1/change-requests/${id}`,'EDITOR')).status).toBe(200);expect(db.findFirst.mock.calls[0]![0]).toEqual({where:{id,requestedById:actor}});
  expect(db.create).not.toHaveBeenCalled();expect(db.audit).not.toHaveBeenCalled();
 });
 it('rejects editor requester filter and cannot bypass ownership',async()=>{for(const requester of [actor,other])expect((await get(`/api/v1/change-requests?requestedById=${requester}`,'EDITOR')).status).toBe(403);expect(db.transaction).not.toHaveBeenCalled();});
 it.each(['REVIEWER','ADMIN'])('%s can read all and combine filters',async role=>{
  const res=await get(`/api/v1/change-requests?status=APPROVED&entityType=PopulationRecord&entityId=${target}&requestedById=${other}&page=2&limit=200`,role);expect(res.status).toBe(200);expect(res.body.meta).toMatchObject({page:2,limit:100,total:1});
  const expected={status:'APPROVED',entityType:'PopulationRecord',entityId:target,requestedById:other};expect(db.count.mock.calls[0]![0].where).toEqual(expected);expect(db.findMany.mock.calls[0]![0]).toMatchObject({where:expected,skip:100,take:100});
  expect((await get(`/api/v1/change-requests/${id}`,role)).status).toBe(200);expect(db.findFirst.mock.calls[0]![0]).toEqual({where:{id}});
 });
 it('returns identical missing and inaccessible detail responses',async()=>{db.findFirst.mockResolvedValue(null);const a=await get(`/api/v1/change-requests/${id}`,'EDITOR'),b=await get(`/api/v1/change-requests/${other}`,'EDITOR');expect(a.status).toBe(404);expect(b.status).toBe(404);expect(a.body.error).toMatchObject({code:'NOT_FOUND',message:'Change request not found',details:[]});expect(b.body.error).toMatchObject({code:a.body.error.code,message:a.body.error.message,details:a.body.error.details});});
 it.each(['PENDING','APPROVED','REJECTED'])('filters and returns %s historical requests without looking up targets',async status=>{db.findMany.mockResolvedValue([{...row,status}]);const res=await get(`/api/v1/change-requests?status=${status}`,'REVIEWER');expect(res.status).toBe(200);expect(res.body.data[0].status).toBe(status);expect(db.findMany.mock.calls[0]![0].where.status).toBe(status);expect(res.body.data[0]).not.toHaveProperty('passwordHash');expect(res.body.data[0]).not.toHaveProperty('token');});
 it.each(['entityType=PopulationRecord',`entityId=${target}`,`requestedById=${other}`])('supports individual filter %s',async query=>{expect((await get(`/api/v1/change-requests?${query}`,'ADMIN')).status).toBe(200);const [key,value]=query.split('=');expect(db.count.mock.calls[0]![0].where[key!]).toBe(value);});
 it.each(['page=0','page=-1','page=1.5','page=abc','page=','page=1&page=2','limit=1&limit=2','limit=0','status=PENDING&status=APPROVED','status=BAD','entityType=Village','entityId=bad','requestedById=bad',`entityId=${target}&entityId=${id}`,'page=2147483648'])('rejects invalid or repeated %s',async query=>{expect((await get(`/api/v1/change-requests?${query}`,'ADMIN')).status).toBe(400);expect(db.transaction).not.toHaveBeenCalled();});
 it('rejects invalid detail UUID and ignores unknown query fields',async()=>{expect((await get('/api/v1/change-requests/bad','ADMIN')).status).toBe(400);expect((await get('/api/v1/change-requests?unknown=value','ADMIN')).status).toBe(200);expect(db.count.mock.calls[0]![0].where).not.toHaveProperty('unknown');});
 it('returns empty pages with filtered totals',async()=>{db.count.mockResolvedValue(0);db.findMany.mockResolvedValue([]);const res=await get('/api/v1/change-requests','EDITOR');expect(res.body).toMatchObject({data:[],meta:{total:0,totalPages:0,hasNextPage:false,hasPrevPage:false}});});
 it('propagates unexpected database failures through the error handler',async()=>{db.findFirst.mockRejectedValueOnce(new Error('private'));expect((await get(`/api/v1/change-requests/${id}`,'ADMIN')).status).toBe(500);db.count.mockRejectedValueOnce(new Error('private'));expect((await get('/api/v1/change-requests','ADMIN')).status).toBe(500);});
 it('enforces service roles without route middleware',async()=>{const {changeRequestsService}=await import('../src/modules/change-requests/change-requests.service.js');await expect(changeRequestsService.list({}, {actorId:actor,role:'VISITOR' as never})).rejects.toMatchObject({statusCode:403});await expect(changeRequestsService.getById(id,{actorId:actor,role:'VISITOR' as never})).rejects.toMatchObject({statusCode:403});});
});
