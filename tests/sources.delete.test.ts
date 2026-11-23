import { AuditAction, SourceType, VerificationStatus, type Source } from '@prisma/client';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), update: vi.fn(), audit: vi.fn(), transaction: vi.fn(),
  hardDelete: vi.fn(), hardDeleteMany: vi.fn(),
  rootRead: vi.fn(), rootUpdate: vi.fn(), rootAudit: vi.fn(),
}));
vi.mock('../src/shared/db.js', () => ({ prisma: {
  source: { findFirst: mocks.rootRead, update: mocks.rootUpdate,
    delete: mocks.hardDelete, deleteMany: mocks.hardDeleteMany },
  auditLog: { create: mocks.rootAudit }, $transaction: mocks.transaction,
} }));
vi.mock('../src/shared/cache.js', () => ({ redis: {} }));
const tx = { source: { findFirst: mocks.read, update: mocks.update,
  delete: mocks.hardDelete, deleteMany: mocks.hardDeleteMany }, auditLog: { create: mocks.audit } };
const actorId = '11111111-1111-4111-8111-111111111111';
const otherId = '33333333-3333-4333-8333-333333333333';
const id = '22222222-2222-4222-8222-222222222222';
const secret = 'synthetic-source-delete-secret-at-least-32-characters';
const select = {
  id: true, title: true, author: true, publisher: true, year: true, url: true,
  sourceType: true, citationText: true, verificationStatus: true, version: true,
  createdAt: true, updatedAt: true, deletedAt: true,
};
const original: Source = {
  id, title: 'Reference', sourceType: SourceType.BOOK, author: 'Author', publisher: 'Publisher',
  year: 2020, url: 'https://example.invalid/reference', citationText: 'Citation',
  verificationStatus: VerificationStatus.PENDING, version: 3,
  createdById: otherId, updatedById: otherId, deletedAt: null,
  createdAt: new Date('2026-11-01T00:00:00Z'), updatedAt: new Date('2026-11-02T00:00:00Z'),
};
let current: Source;
let app: Express;
function project(row: Source, fields: Record<string, boolean>) {
  return Object.fromEntries(Object.keys(fields).filter(key => fields[key]).map(key => [key, row[key as keyof Source]]));
}
function snapshot(row: Source, url: string | null = row.url) {
  return { id: row.id, title: row.title, sourceType: row.sourceType, author: row.author,
    publisher: row.publisher, year: row.year, url, citationText: row.citationText,
    verificationStatus: row.verificationStatus, version: row.version,
    deletedAt: row.deletedAt?.toISOString() ?? null };
}
beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('LOG_LEVEL', 'silent');
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic:synthetic@localhost:5432/test');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('JWT_ACCESS_SECRET', secret);
  app = (await import('../src/app.js')).createApp();
});
beforeEach(() => {
  vi.resetAllMocks();
  current = { ...original };
  mocks.transaction.mockImplementation((fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  mocks.read.mockImplementation(async ({ where, select: fields }) =>
    Object.entries(where).every(([key, value]) => current[key as keyof Source] === value) ? project(current, fields) : null);
  // Models argument selection and predicates, not PostgreSQL locking or rollback.
  mocks.update.mockImplementation(async ({ where, data, select: fields }) => {
    if (!Object.entries(where).every(([key, value]) => current[key as keyof Source] === value)) throw { code: 'P2025' };
    current = { ...current, deletedAt: data.deletedAt, updatedById: data.updatedById,
      version: current.version + data.version.increment, updatedAt: data.deletedAt };
    return project(current, fields);
  });
  mocks.audit.mockResolvedValue({ id: 'synthetic-audit-id' });
});
function remove(body: unknown = { expectedVersion: 3 }, role = 'ADMIN', sourceId = id) {
  const token = jwt.sign({ role }, secret, { subject: actorId, algorithm: 'HS256', expiresIn: '15m' });
  return request(app).delete(`/api/v1/sources/${sourceId}`).set('Authorization', `Bearer ${token}`).send(body);
}
function expectNoWrites() {
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
  expect(mocks.hardDelete).not.toHaveBeenCalled();
  expect(mocks.hardDeleteMany).not.toHaveBeenCalled();
  expect(mocks.rootUpdate).not.toHaveBeenCalled();
  expect(mocks.rootAudit).not.toHaveBeenCalled();
}

describe('DELETE Sources', () => {
  it.each(Object.values(VerificationStatus))('allows ADMIN to soft-delete %s with safe Audit and a receipt', async status => {
    current.verificationStatus = status;
    const before = { ...current };
    const response = await remove().set('X-Request-Id', 'source-delete-123');
    expect(response.status).toBe(200);
    expect(current.deletedAt).toBeInstanceOf(Date);
    expect(response.body).toEqual({ data: { id, version: 4, deletedAt: current.deletedAt!.toISOString() } });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith({ where: { id, deletedAt: null }, select });
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      where: { id, deletedAt: null, version: 3 },
      data: { deletedAt: current.deletedAt, updatedById: actorId, version: { increment: 1 } }, select,
    });
    expect(current).toEqual({ ...before, deletedAt: current.deletedAt,
      version: 4, updatedById: actorId, updatedAt: current.deletedAt });
    expect(mocks.audit).toHaveBeenCalledExactlyOnceWith({ data: {
      entityType: 'Source', entityId: id, action: AuditAction.DELETE,
      actorId, requestId: 'source-delete-123', before: snapshot(before), after: snapshot(current),
    } });
    expect(mocks.rootRead).not.toHaveBeenCalled();
    expect(mocks.rootUpdate).not.toHaveBeenCalled();
    expect(mocks.rootAudit).not.toHaveBeenCalled();
    expect(mocks.hardDelete).not.toHaveBeenCalled();
    expect(mocks.hardDeleteMany).not.toHaveBeenCalled();
  });
  it.each([undefined, 'Bearer invalid'])('requires authentication (%s)', async authorization => {
    const req = request(app).delete(`/api/v1/sources/${id}`);
    if (authorization) req.set('Authorization', authorization);
    const response = await req.send({ expectedVersion: 3 });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(mocks.transaction).not.toHaveBeenCalled();
    expectNoWrites();
  });
  it.each(['EDITOR', 'REVIEWER'])('rejects %s before validation or database access', async role => {
    const response = await remove({}, role);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(mocks.transaction).not.toHaveBeenCalled();
    expectNoWrites();
  });
  it.each(['EDITOR', 'REVIEWER'] as const)('also rejects direct service deletion by %s', async role => {
    const { sourceService } = await import('../src/modules/sources/sources.service.js');
    await expect(sourceService.softDelete(id, { expectedVersion: 3 },
      { actorId, role, requestId: 'synthetic-request' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expectNoWrites();
  });
  it.each([
    {}, null, [], { expectedVersion: 0 }, { expectedVersion: -1 }, { expectedVersion: 1.5 },
    { expectedVersion: '3' }, { expectedVersion: null }, { expectedVersion: true },
    ...['version', 'title', 'deletedAt', 'updatedById', 'createdById', 'actorId', 'requestId', 'role',
      'verificationStatus', 'unknown'].map(field => ({ expectedVersion: 3, [field]: 'spoofed' })),
  ])('rejects invalid JSON body %j without database access', async body => {
    // Sending JSON null explicitly avoids supertest treating null as an absent body.
    const response = body === null
      ? await request(app).delete(`/api/v1/sources/${id}`).set('Authorization', `Bearer ${jwt.sign({ role: 'ADMIN' }, secret, { subject: actorId })}`)
        .set('Content-Type', 'application/json').send('null')
      : await remove(body);
    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expectNoWrites();
  });
  it('rejects a missing body and does not use a query-string precondition', async () => {
    const token = jwt.sign({ role: 'ADMIN' }, secret, { subject: actorId });
    const response = await request(app).delete(`/api/v1/sources/${id}?expectedVersion=3`).set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('rejects invalid UUIDs before database access', async () => {
    const response = await remove(undefined, 'ADMIN', 'invalid-id');
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR',
      details: expect.arrayContaining([expect.objectContaining({ field: 'params.id' })]) });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(['missing', 'deleted'])('returns 404 for %s sources before comparing versions', async state => {
    if (state === 'deleted') current.deletedAt = new Date('2026-11-03T00:00:00Z');
    const response = await remove({ expectedVersion: 1 }, 'ADMIN', state === 'missing' ? otherId : id);
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Source not found' });
    expectNoWrites();
  });
  it.each([1, 2, 4])('returns 409 for mismatched expectedVersion %s', async expectedVersion => {
    const response = await remove({ expectedVersion });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
    expectNoWrites();
  });
  it('returns 404 on a repeated delete', async () => {
    expect((await remove()).status).toBe(200);
    mocks.update.mockClear();
    mocks.audit.mockClear();
    expect((await remove()).status).toBe(404);
    expectNoWrites();
  });
  it.each([
    { version: 4 }, { deletedAt: new Date('2026-11-03T00:00:00Z') }, { id: otherId },
  ])('enforces conditional predicates against a simulated race %j', async change => {
    const applyUpdate = mocks.update.getMockImplementation()!;
    mocks.update.mockImplementation(async args => {
      Object.assign(current, change);
      return applyUpdate(args);
    });
    const response = await remove();
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('maps P2025 from the conditional update to CONFLICT', async () => {
    mocks.update.mockRejectedValue({ code: 'P2025' });
    expect((await remove()).status).toBe(409);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it.each([
    ['https://synthetic-user:synthetic-password@example.invalid/reference?token=synthetic-token#synthetic-fragment', 'https://example.invalid/reference'],
    ['http://example.invalid/reference?API_KEY=synthetic-key&safe=value#synthetic-fragment', 'http://example.invalid/reference'],
    ['malformed synthetic URL?password=synthetic-password', null],
    ['ftp://synthetic-user:synthetic-password@example.invalid/reference', null],
    [null, null],
  ])('redacts legacy URL %s from both Audit snapshots', async (url, safeUrl) => {
    current.url = url;
    const before = { ...current };
    const response = await remove();
    expect(response.status).toBe(200);
    expect(response.body.data).not.toHaveProperty('url');
    const audit = mocks.audit.mock.calls[0]?.[0].data;
    expect(audit.before).toEqual(snapshot(before, safeUrl));
    expect(audit.after).toEqual(snapshot(current, safeUrl));
    expect(JSON.stringify(audit)).not.toMatch(/synthetic-user|synthetic-password|synthetic-token|synthetic-key|synthetic-fragment|safe=value/);
    expect(current.url).toBe(url);
  });
  it('uses the generated request ID in Audit when no header is supplied', async () => {
    const response = await remove();
    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(mocks.audit.mock.calls[0]?.[0].data.requestId).toBe(response.headers['x-request-id']);
  });
  it.each(['read', 'update', 'audit', 'transaction'] as const)('propagates %s errors through the shared handler', async operation => {
    mocks[operation].mockRejectedValue(new Error('synthetic-private-error'));
    const response = await remove();
    expect(response.status).toBe(500);
    expect(response.body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Internal server error',
      requestId: response.headers['x-request-id'] });
    expect(JSON.stringify(response.body)).not.toContain('synthetic-private-error');
    if (operation === 'read' || operation === 'transaction') expectNoWrites();
    if (operation === 'update') expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('rejects the transaction callback on Audit failure without claiming real database rollback', async () => {
    const error = Object.assign(new Error('synthetic Audit failure'), { code: 'P2025' });
    mocks.audit.mockRejectedValue(error);
    const { sourceService } = await import('../src/modules/sources/sources.service.js');
    await expect(sourceService.softDelete(id, { expectedVersion: 3 },
      { actorId, role: 'ADMIN', requestId: 'synthetic-request' })).rejects.toBe(error);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.read.mock.invocationCallOrder[0]).toBeLessThan(mocks.update.mock.invocationCallOrder[0]!);
    expect(mocks.update.mock.invocationCallOrder[0]).toBeLessThan(mocks.audit.mock.invocationCallOrder[0]!);
    expect(mocks.rootAudit).not.toHaveBeenCalled();
  });
  it('hides a deleted Source from subsequent public detail and list reads', async () => {
    expect((await remove()).status).toBe(200);
    mocks.rootRead.mockImplementation(mocks.read.getMockImplementation()!);
    const detail = await request(app).get(`/api/v1/sources/${id}`);
    expect(detail.status).toBe(404);
    // This fake honors the supplied deletion filter; it is not a real database.
    Object.assign(tx.source, {
      count: vi.fn(async ({ where }) => current.deletedAt === where.deletedAt ? 1 : 0),
      findMany: vi.fn(async ({ where }) => current.deletedAt === where.deletedAt ? [project(current, select)] : []),
    });
    const list = await request(app).get('/api/v1/sources');
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);
    expect(list.body.meta.total).toBe(0);
  });
});
