import type { EconomicActivity } from '@prisma/client';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateEconomySchema } from '../src/modules/economy/economy.schemas.js';
const db = vi.hoisted(() => ({ find: vi.fn(), update: vi.fn(), audit: vi.fn(), transaction: vi.fn(), lock: vi.fn(), source: vi.fn(), village: vi.fn(), count: vi.fn(), list: vi.fn() }));
vi.mock('../src/shared/db.js', () => ({ prisma: { economicActivity: { findFirst: db.find }, $transaction: db.transaction } }));
vi.mock('../src/shared/cache.js', () => ({ redis: {} }));
const id = '11111111-1111-4111-8111-111111111111';
const villageId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const sourceId = '44444444-4444-4444-8444-444444444444';
const newSourceId = '55555555-5555-4555-8555-555555555555';
const secret = 'economy-write-tests-secret-at-least-32-characters';
const tx = { economicActivity: { findFirst: db.find, updateMany: db.update, count: db.count, findMany: db.list },
  auditLog: { create: db.audit }, $queryRaw: db.lock, source: { findFirst: db.source }, village: { findFirst: db.village } };
let app: Express;
let row: EconomicActivity | null;
let villageActive: boolean;
let sourceActive: boolean;
let audits: unknown[];
beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('LOG_LEVEL', 'silent'); vi.stubEnv('RATE_LIMIT_ENABLED', 'false');
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost:5432/test'); vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('JWT_ACCESS_SECRET', secret); app = (await import('../src/app.js')).createApp();
});
beforeEach(() => {
  vi.resetAllMocks(); villageActive = true; sourceActive = true; audits = [];
  row = { id, villageId, name: 'Olives', category: 'CROP', description: 'Original', isMajor: true, asOfYear: 2020,
    sourceId, verificationStatus: 'PENDING', version: 1, createdById: actorId, updatedById: actorId,
    deletedAt: null, createdAt: new Date('2026-11-24T00:00:00Z'), updatedAt: new Date('2026-11-24T00:00:00Z') };
  const visible = (where: { id?: string; villageId?: string; deletedAt?: null; village?: unknown }) =>
    row && (!where.id || row.id === where.id) && (!where.villageId || row.villageId === where.villageId) &&
    (!where.village || villageActive) && (where.deletedAt !== null || !row.deletedAt);
  const project = (select: object) => Object.fromEntries(Object.keys(select).map(key => [key, row![key as keyof EconomicActivity]]));
  db.find.mockImplementation(async ({ where, select }) => visible(where) ? project(select) : null);
  db.list.mockImplementation(async ({ where, select }) => visible(where) ? [project(select)] : []);
  db.count.mockImplementation(async ({ where }) => visible(where) ? 1 : 0);
  db.village.mockImplementation(async () => villageActive ? { id: villageId } : null);
  db.lock.mockImplementation(async (query: TemplateStringsArray) => {
    const sql = query.join('');
    return (sql.includes('FROM villages') ? villageActive : sql.includes('FROM sources') ? sourceActive : !!row) ? [{ id }] : [];
  });
  db.source.mockImplementation(async () => sourceActive ? { id: newSourceId } : null);
  db.update.mockImplementation(async ({ where, data }) => {
    if (!visible(where) || (where.version !== undefined && row!.version !== where.version)) return { count: 0 };
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) Object.assign(row!, { [key]: key === 'version' ? row!.version + 1 : value });
    }
    row!.updatedAt = new Date(); return { count: 1 };
  });
  db.audit.mockImplementation(async ({ data }) => { audits.push(data); return data; });
  // Model transaction rollback, not live PostgreSQL scheduling.
  db.transaction.mockImplementation(async fn => {
    const before = row && { ...row }; const previousAudits = [...audits];
    try { return await fn(tx); } catch (error) { row = before; audits = previousAudits; throw error; }
  });
});
function call(method: 'patch' | 'delete', body: object = { version: 1, name: 'Updated' }, role = 'ADMIN', target = id) {
  const req = request(app)[method](`/api/v1/economy/${target}`).set('X-Request-Id', 'economy-write');
  if (role) req.set('Authorization', 'Bearer ' + jwt.sign({ role }, secret, { subject: actorId, algorithm: 'HS256' }));
  return req.send(body);
}
describe('Economy PATCH and DELETE through the real HTTP/service/repository layers', () => {
  it.each(['EDITOR', 'REVIEWER', 'ADMIN'])('updates as %s, preserves omitted values and writes one audit', async role => {
    const response = await call('patch', undefined, role);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ name: 'Updated', description: 'Original', isMajor: true, asOfYear: 2020, version: 2, sourceId });
    expect(response.body.data).not.toHaveProperty('createdById'); expect(response.body.data).not.toHaveProperty('updatedById');
    expect(db.update).toHaveBeenCalledExactlyOnceWith({ where: { id, version: 1, deletedAt: null, village: { deletedAt: null } },
      data: { name: 'Updated', verificationStatus: 'PENDING', updatedById: actorId, version: { increment: 1 } } });
    expect(audits).toEqual([expect.objectContaining({ entityType: 'EconomicActivity', entityId: id, action: 'UPDATE', actorId, requestId: 'economy-write',
      before: expect.objectContaining({ name: 'Olives', version: 1 }), after: expect.objectContaining({ name: 'Updated', version: 2 }) })]);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
  it.each(['VERIFIED', 'REJECTED'] as const)('rejects editor changes to %s before checking version', async status => {
    row!.verificationStatus = status;
    const response = await call('patch', { version: 99, name: 'X' }, 'EDITOR');
    expect(response.status).toBe(403); expect(response.body.error.code).toBe('CHANGE_REQUEST_REQUIRED'); expect(db.update).not.toHaveBeenCalled();
  });
  it.each([null, sourceId])('rejects another/no creator %s for EDITOR', async creator => {
    row!.createdById = creator;
    const response = await call('patch', undefined, 'EDITOR');
    expect(response.status).toBe(403); expect(response.body.error.code).toBe('ECONOMY_EDIT_FORBIDDEN'); expect(audits).toEqual([]);
  });
  it.each(['REVIEWER', 'ADMIN'])('allows %s to edit reviewed records from another creator', async role => {
    row!.createdById = null; row!.verificationStatus = 'VERIFIED';
    expect((await call('patch', undefined, role)).body.data.verificationStatus).toBe('PENDING');
  });
  it.each(['patch', 'delete'] as const)('requires valid authentication for %s', async method => {
    expect((await call(method, {}, '')).status).toBe(401);
    expect((await call(method).set('Authorization', 'Bearer invalid')).status).toBe(401);
    const expired = jwt.sign({ role: 'ADMIN' }, secret, { subject: actorId, expiresIn: -1 });
    expect((await call(method).set('Authorization', 'Bearer ' + expired)).status).toBe(401);
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it.each(['EDITOR', 'REVIEWER'])('forbids deletion by %s before validation', async role => {
    expect((await call('delete', {}, role, 'invalid')).status).toBe(403); expect(db.transaction).not.toHaveBeenCalled();
  });
  it('returns VERSION_CONFLICT and the current version on a stale update', async () => {
    row!.version = 2;
    const response = await call('patch');
    expect(response.status).toBe(409); expect(response.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: [{ field: 'version', message: 'Current version is 2' }] });
    expect(db.update).not.toHaveBeenCalled(); expect(audits).toEqual([]);
  });
  it.each(['edit', 'delete'])('detects concurrent %s at the guarded update', async operation => {
    db.update.mockImplementationOnce(async () => { if (operation === 'edit') row!.version++; else row!.deletedAt = new Date(); return { count: 0 }; });
    expect((await call('patch')).status).toBe(operation === 'edit' ? 409 : 404); expect(audits).toEqual([]);
  });
  it('checks changed sources with village/source locks and preserves zero/false/null', async () => {
    const response = await call('patch', { version: 1, sourceId: newSourceId, isMajor: false, asOfYear: 0, description: null });
    expect(response.status).toBe(200); expect(response.body.data).toMatchObject({ sourceId: newSourceId, isMajor: false, asOfYear: 0, description: null });
    expect(db.lock.mock.calls.map(([sql]) => sql.join('?').trim())).toEqual([
      'SELECT id FROM villages WHERE id = ?::uuid AND deleted_at IS NULL FOR SHARE',
      'SELECT id FROM sources WHERE id = ?::uuid AND deleted_at IS NULL FOR SHARE',
    ]);
    expect(db.source).toHaveBeenCalled();
  });
  it('rejects a missing/deleted replacement source but allows an unchanged deleted source', async () => {
    sourceActive = false;
    expect((await call('patch', { version: 1, sourceId: newSourceId })).status).toBe(404);
    expect(db.update).not.toHaveBeenCalled(); expect(audits).toEqual([]);
    expect((await call('patch', { version: 1, sourceId, name: 'Unrelated' })).status).toBe(200);
    expect(db.source).not.toHaveBeenCalled();
  });
  it.each(['patch', 'delete'] as const)('returns 404 for missing/deleted activity or parent on %s', async method => {
    row!.deletedAt = new Date(); expect((await call(method)).status).toBe(404);
    row!.deletedAt = null; villageActive = false; expect((await call(method)).status).toBe(404);
    villageActive = true; row = null; expect((await call(method)).status).toBe(404);
    expect(db.update).not.toHaveBeenCalled(); expect(audits).toEqual([]);
  });
  it.each(['patch', 'delete'] as const)('rejects %s if parent disappears before locking', async method => {
    db.lock.mockResolvedValueOnce([]); expect((await call(method)).status).toBe(404); expect(db.update).not.toHaveBeenCalled();
  });
  it.each(['patch', 'delete'] as const)('rolls back %s on audit failure', async method => {
    const original = { ...row! }; db.audit.mockRejectedValueOnce(new Error('private database failure'));
    const response = await call(method); expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('private database'); expect(row).toEqual(original); expect(audits).toEqual([]);
  });
  it('soft deletes once, retains version and relations, hides public detail/list, then returns 404', async () => {
    expect((await call('delete')).status).toBe(204);
    expect(row).toMatchObject({ id, villageId, sourceId, version: 1, deletedAt: expect.any(Date), updatedById: actorId });
    expect(audits).toEqual([expect.objectContaining({ action: 'DELETE', before: expect.objectContaining({ deletedAt: null }), after: expect.objectContaining({ deletedAt: expect.any(String) }) })]);
    expect((await request(app).get(`/api/v1/economy/${id}`)).status).toBe(404);
    const list = await request(app).get(`/api/v1/villages/${villageId}/economy`);
    expect(list.status).toBe(200); expect(list.body).toMatchObject({ data: [], meta: { total: 0 } });
    expect((await call('delete')).status).toBe(404); expect(audits).toHaveLength(1);
  });
  it('takes a fresh deletion audit snapshot after a concurrent edit', async () => {
    const lock = db.lock.getMockImplementation()!;
    db.lock.mockImplementation(async (sql: TemplateStringsArray) => {
      if (sql.join('').includes('economic_activities')) { row!.name = 'Concurrent'; row!.version = 2; }
      return lock(sql);
    });
    expect((await call('delete')).status).toBe(204);
    expect(audits[0]).toMatchObject({ before: { name: 'Concurrent', version: 2 }, after: { version: 2 } });
    expect(db.lock.mock.calls[1]![0].join('?')).toContain('economic_activities WHERE id = ?::uuid FOR UPDATE');
  });
  it.each([{}, { version: 1 }, { version: '1', name: 'X' }, { version: 0, name: 'X' }, { version: 2147483647, name: 'X' },
    { version: 1, name: '' }, { version: 1, category: 'bad' }, { version: 1, sourceId: null },
    { version: 1, isMajor: 'false' }, { version: 1, asOfYear: 1.5 }, { version: 1, asOfYear: 2147483648 },
    { version: 1, name: 'x'.repeat(201) }, { version: 1, description: 'x'.repeat(5001) },
  ])('rejects invalid PATCH %j', async body => {
    expect((await call('patch', body)).status).toBe(400); expect(db.transaction).not.toHaveBeenCalled();
  });
  it.each(['verificationStatus', 'createdById', 'updatedById', 'deletedAt', 'villageId', 'id', 'createdAt', 'updatedAt', 'unknown'])('rejects protected field %s', async field => {
    expect((await call('patch', { version: 1, name: 'X', [field]: id })).status).toBe(400); expect(db.update).not.toHaveBeenCalled();
  });
  it.each(['patch', 'delete'] as const)('validates %s identifier', async method => {
    expect((await call(method, undefined, 'ADMIN', 'bad-id')).status).toBe(400);
  });
  it('validates nullable year and trims partial updates without supplying defaults', () => {
    expect(updateEconomySchema.parse({ version: 1, name: ' X ', asOfYear: null })).toEqual({ version: 1, name: 'X', asOfYear: null });
  });
});
