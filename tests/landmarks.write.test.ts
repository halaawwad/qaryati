import { Prisma, type Landmark } from '@prisma/client';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateLandmarkSchema } from '../src/modules/landmarks/landmarks.schemas.js';

const mocks = vi.hoisted(() => ({ find: vi.fn(), update: vi.fn(), audit: vi.fn(), transaction: vi.fn(), lock: vi.fn(), source: vi.fn() }));
vi.mock('../src/shared/db.js', () => ({ prisma: {
  landmark: { findFirst: mocks.find }, $transaction: mocks.transaction,
} }));
vi.mock('../src/shared/cache.js', () => ({ redis: {} }));
const id = '11111111-1111-4111-8111-111111111111';
const villageId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const sourceId = '44444444-4444-4444-8444-444444444444';
const secret = 'landmark-tests-secret-at-least-32-characters';
const tx = { landmark: { findFirst: mocks.find, updateMany: mocks.update },
  auditLog: { create: mocks.audit }, $queryRaw: mocks.lock, source: { findFirst: mocks.source } };
let app: Express;
let row: Landmark | null;
let villageActive: boolean;
let sourceActive: boolean;
let audits: unknown[];
beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('LOG_LEVEL', 'silent');
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost:5432/test');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379'); vi.stubEnv('JWT_ACCESS_SECRET', secret);
  vi.stubEnv('RATE_LIMIT_ENABLED', 'false');
  app = (await import('../src/app.js')).createApp();
});
beforeEach(() => {
  vi.resetAllMocks(); villageActive = true; sourceActive = true; audits = [];
  row = { id, villageId, nameAr: 'عين البلد', nameEn: 'Spring', landmarkType: 'SPRING',
    description: null, latitude: new Prisma.Decimal(31), longitude: new Prisma.Decimal(35), sourceId,
    verificationStatus: 'PENDING', version: 1, createdById: actorId, updatedById: actorId,
    deletedAt: null, createdAt: new Date('2026-11-24T00:00:00Z'), updatedAt: new Date('2026-11-24T00:00:00Z') };
  mocks.find.mockImplementation(async ({ where, select }) => {
    if (!row || row.id !== where.id || !villageActive || (where.deletedAt === null && row.deletedAt)) return null;
    return Object.fromEntries(Object.keys(select).map(key => [key, row![key as keyof Landmark]]));
  });
  mocks.lock.mockImplementation(async (query: TemplateStringsArray) => {
    const text = query.join('');
    return (text.includes('FROM villages') ? villageActive : text.includes('FROM sources') ? sourceActive : !!row) ? [{ id }] : [];
  });
  mocks.source.mockImplementation(async () => sourceActive ? { id: sourceId } : null);
  mocks.update.mockImplementation(async ({ where, data }) => {
    if (!row || row.deletedAt || !villageActive || (where.version !== undefined && row.version !== where.version)) return { count: 0 };
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (key === 'version') row.version++;
      else if (key === 'latitude' || key === 'longitude') row[key] = value === null ? null : new Prisma.Decimal(value as number);
      else Object.assign(row, { [key]: value });
    }
    row.updatedAt = new Date();
    return { count: 1 };
  });
  mocks.audit.mockImplementation(async ({ data }) => { audits.push(data); return data; });
  // Models transaction wiring and rollback, not PostgreSQL execution.
  mocks.transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => {
    const original = row && { ...row }; const originalAudits = [...audits];
    try { return await fn(tx); } catch (error) { row = original; audits = originalAudits; throw error; }
  });
});
function call(method: 'patch' | 'delete', body: object = { version: 1, nameEn: 'New name' }, role = 'ADMIN', target = id) {
  const req = request(app)[method](`/api/v1/landmarks/${target}`).set('X-Request-Id', 'landmark-write-test');
  if (role) req.set('Authorization', `Bearer ${jwt.sign({ role }, secret, { subject: actorId, algorithm: 'HS256' })}`);
  return req.send(body);
}

describe('landmark writes through HTTP, service and repository', () => {
  it.each(['EDITOR', 'REVIEWER', 'ADMIN'])('updates as %s with version guard, safe response and transactional audit', async role => {
    const response = await call('patch', undefined, role);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ nameEn: 'New name', nameAr: 'عين البلد', version: 2, latitude: 31 });
    expect(response.body.data).not.toHaveProperty('createdById');
    expect(response.body.data).not.toHaveProperty('updatedById');
    expect(mocks.update).toHaveBeenCalledWith({ where: { id, version: 1, deletedAt: null, village: { deletedAt: null } },
      data: { nameEn: 'New name', verificationStatus: 'PENDING', version: { increment: 1 }, updatedById: actorId } });
    expect(audits).toEqual([expect.objectContaining({ entityType: 'Landmark', entityId: id, action: 'UPDATE', actorId,
      requestId: 'landmark-write-test', before: expect.objectContaining({ version: 1, nameEn: 'Spring' }),
      after: expect.objectContaining({ version: 2, nameEn: 'New name' }) })]);
  });
  it.each(['patch', 'delete'] as const)('requires authentication for %s', async method => {
    expect((await call(method, {}, '')).status).toBe(401); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(['EDITOR', 'REVIEWER'])('forbids deletion by %s', async role => {
    expect((await call('delete', {}, role)).status).toBe(403); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(['VERIFIED', 'REJECTED'] as const)('prevents editor changes to %s records even with a stale version', async status => {
    row!.verificationStatus = status;
    const response = await call('patch', { version: 99, nameEn: 'X' }, 'EDITOR');
    expect(response.status).toBe(403); expect(response.body.error.code).toBe('CHANGE_REQUEST_REQUIRED');
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each([null, sourceId])('forbids editor changes when owner is %s', async owner => {
    row!.createdById = owner;
    expect((await call('patch', undefined, 'EDITOR')).body.error.code).toBe('LANDMARK_EDIT_FORBIDDEN');
    expect(audits).toEqual([]);
  });
  it.each(['REVIEWER', 'ADMIN'])('allows %s to edit reviewed content and resets status', async role => {
    row!.verificationStatus = 'VERIFIED'; row!.createdById = null;
    expect((await call('patch', undefined, role)).body.data.verificationStatus).toBe('PENDING');
  });
  it.each(['patch', 'delete'] as const)('returns 404 for missing, deleted or hidden-parent landmarks on %s', async method => {
    row!.deletedAt = new Date(); expect((await call(method)).status).toBe(404);
    row!.deletedAt = null; villageActive = false; expect((await call(method)).status).toBe(404);
    villageActive = true; row = null; expect((await call(method)).status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled(); expect(audits).toEqual([]);
  });
  it('reports current version for stale updates without audit', async () => {
    row!.version = 2;
    const response = await call('patch');
    expect(response.status).toBe(409); expect(response.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: [{ field: 'version', message: 'Current version is 2' }] });
    expect(mocks.update).not.toHaveBeenCalled(); expect(audits).toEqual([]);
  });
  it.each(['edit', 'delete'])('detects a concurrent %s at the guarded update', async operation => {
    mocks.update.mockImplementationOnce(async () => { if (operation === 'edit') row!.version++; else row!.deletedAt = new Date(); return { count: 0 }; });
    expect((await call('patch')).status).toBe(operation === 'edit' ? 409 : 404); expect(audits).toEqual([]);
  });
  it('locks and validates a replacement source, allowing unrelated edits when old source is deleted', async () => {
    sourceActive = false;
    expect((await call('patch', { version: 1, sourceId })).status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
    expect((await call('patch')).status).toBe(200);
  });
  it('updates valid sources and clears nullable fields without changing identity', async () => {
    const response = await call('patch', { version: 1, sourceId, nameEn: null, description: null, latitude: null, longitude: null });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ id, villageId, sourceId, nameEn: null, latitude: null, longitude: null });
    expect(mocks.source).toHaveBeenCalled();
    expect(mocks.lock.mock.calls.map(([query]) => (query as TemplateStringsArray).join('?').trim())).toEqual([
      'SELECT id FROM villages WHERE id = ?::uuid AND deleted_at IS NULL FOR SHARE',
      'SELECT id FROM sources WHERE id = ?::uuid AND deleted_at IS NULL FOR SHARE',
    ]);
  });
  it.each(['patch', 'delete'] as const)('rejects %s if the parent disappears before its lock is acquired', async method => {
    mocks.lock.mockResolvedValueOnce([]);
    expect((await call(method)).status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled(); expect(audits).toEqual([]);
  });
  it('audits an edit completed before the delete lock using a fresh snapshot', async () => {
    const lock = mocks.lock.getMockImplementation()!;
    mocks.lock.mockImplementation(async (query: TemplateStringsArray) => {
      if (query.join('').includes('FROM landmarks')) { row!.nameEn = 'Concurrent edit'; row!.version = 2; }
      return lock(query);
    });
    expect((await call('delete')).status).toBe(204);
    expect(audits[0]).toMatchObject({ before: { nameEn: 'Concurrent edit', version: 2 }, after: { version: 2 } });
    expect(mocks.lock.mock.calls.map(([query]) => (query as TemplateStringsArray).join('?').trim())).toEqual([
      'SELECT id FROM villages WHERE id = ?::uuid AND deleted_at IS NULL FOR SHARE',
      'SELECT id FROM landmarks WHERE id = ?::uuid FOR UPDATE',
    ]);
  });
  it.each(['patch', 'delete'] as const)('rolls back %s on audit failure without exposing database details', async method => {
    const original = { ...row! }; mocks.audit.mockRejectedValueOnce(new Error('private database failure'));
    const response = await call(method);
    expect(response.status).toBe(500); expect(JSON.stringify(response.body)).not.toContain('private database');
    expect(row).toEqual(original); expect(audits).toEqual([]);
  });
  it('soft deletes, preserves version and relations, audits, hides detail and returns 404 on repeat', async () => {
    expect((await call('delete')).status).toBe(204);
    expect(row).toMatchObject({ id, villageId, sourceId, version: 1, deletedAt: expect.any(Date), updatedById: actorId });
    expect(audits).toEqual([expect.objectContaining({ action: 'DELETE', before: expect.objectContaining({ deletedAt: null }), after: expect.objectContaining({ deletedAt: expect.any(String) }) })]);
    expect((await request(app).get(`/api/v1/landmarks/${id}`)).status).toBe(404);
    expect((await call('delete')).status).toBe(404); expect(audits).toHaveLength(1);
  });
  it.each([{}, { version: 1 }, { version: '1', nameEn: 'X' }, { version: 1, villageId },
    { version: 1, verificationStatus: 'VERIFIED' }, { version: 1, sourceId: null }, { version: 1, nameAr: '' },
    { version: 1, latitude: null }, { version: 1, latitude: 1, longitude: null }, { version: 1, latitude: 91, longitude: 0 },
  ])('rejects invalid patch %j', async body => {
    expect((await call('patch', body)).status).toBe(400); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(['patch', 'delete'] as const)('validates %s identifiers', async method => {
    expect((await call(method, undefined, 'ADMIN', 'bad-id')).status).toBe(400);
  });
});

describe('partial update schema boundaries', () => {
  it.each([{ latitude: 0, longitude: 0 }, { latitude: -90, longitude: 180 }, { latitude: null, longitude: null }])('accepts paired coordinates %j', fields => {
    expect(updateLandmarkSchema.safeParse({ version: 1, ...fields }).success).toBe(true);
  });
  it.each(['createdById', 'updatedById', 'deletedAt', 'createdAt', 'id', 'unexpected'])('rejects protected field %s', field => {
    expect(updateLandmarkSchema.safeParse({ version: 1, nameEn: 'X', [field]: id }).success).toBe(false);
  });
  it.each([0, -1, 1.5, 2147483647])('rejects invalid version %s', version => {
    expect(updateLandmarkSchema.safeParse({ version, nameEn: 'X' }).success).toBe(false);
  });
});
