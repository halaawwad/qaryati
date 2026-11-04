import { AuditAction, SourceType, VerificationStatus, type Role, type Source } from '@prisma/client';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), update: vi.fn(), audit: vi.fn(), transaction: vi.fn(),
  rootRead: vi.fn(), rootUpdate: vi.fn(), rootAudit: vi.fn(),
}));
vi.mock('../src/shared/db.js', () => ({ prisma: {
  source: { findFirst: mocks.rootRead, update: mocks.rootUpdate },
  auditLog: { create: mocks.rootAudit }, $transaction: mocks.transaction,
} }));
vi.mock('../src/shared/cache.js', () => ({ redis: {} }));

const tx = { source: { findFirst: mocks.read, update: mocks.update }, auditLog: { create: mocks.audit } };
const actorId = '11111111-1111-4111-8111-111111111111';
const otherId = '33333333-3333-4333-8333-333333333333';
const id = '22222222-2222-4222-8222-222222222222';
const secret = 'synthetic-source-update-secret-at-least-32-characters';
const select = {
  id: true, title: true, author: true, publisher: true, year: true, url: true,
  sourceType: true, citationText: true, verificationStatus: true, version: true,
  createdAt: true, updatedAt: true,
};
const original: Source = {
  id, title: 'Original', sourceType: SourceType.BOOK, author: 'Author', publisher: 'Publisher',
  year: 2020, url: 'https://example.invalid/reference', citationText: 'Citation',
  verificationStatus: VerificationStatus.PENDING, version: 3,
  createdById: actorId, updatedById: otherId, deletedAt: null,
  createdAt: new Date('2026-11-01T00:00:00Z'), updatedAt: new Date('2026-11-02T00:00:00Z'),
};
let current: Source;
let app: Express;
const publicRow = (row: Source) => Object.fromEntries(Object.keys(select).map(key => [key, row[key as keyof Source]]));
const snapshot = (row: Source) => {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...fields } = publicRow(row);
  return fields;
};

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
  mocks.read.mockImplementation(async ({ where }) => {
    if (current.id !== where.id || current.deletedAt !== where.deletedAt) return null;
    return { ...publicRow(current), createdById: current.createdById };
  });
  // Apply the supplied data and selection; this fake does not simulate database locking or rollback.
  mocks.update.mockImplementation(async ({ where, data, select: fields }) => {
    if (Object.entries(where).some(([key, value]) => current[key as keyof Source] !== value)) {
      throw { code: 'P2025' };
    }
    const applied = Object.fromEntries(Object.entries(data).filter(([key, value]) => key !== 'version' && value !== undefined));
    const row = { ...current, ...applied, version: current.version + data.version.increment,
      updatedAt: new Date('2026-11-04T00:00:00Z') };
    return Object.fromEntries(Object.keys(fields).map(key => [key, row[key as keyof Source]]));
  });
  mocks.audit.mockResolvedValue({ id: 'synthetic-audit-id' });
});
function patch(body: unknown = { expectedVersion: 3, title: 'Updated' }, role = 'EDITOR', sourceId = id) {
  const token = jwt.sign({ role }, secret, { subject: actorId, algorithm: 'HS256', expiresIn: '15m' });
  return request(app).patch(`/api/v1/sources/${sourceId}`).set('Authorization', `Bearer ${token}`).send(body);
}
function expectNoWrites() {
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
  expect(mocks.rootUpdate).not.toHaveBeenCalled();
  expect(mocks.rootAudit).not.toHaveBeenCalled();
}

describe('PATCH Sources', () => {
  const roles: Role[] = ['EDITOR', 'REVIEWER', 'ADMIN'];
  const matrix = roles.flatMap(role => Object.values(VerificationStatus).flatMap(status =>
    [actorId, otherId, null].map(owner => ({ role, status, owner,
      allowed: status !== 'REJECTED' && (role !== 'EDITOR' || (status === 'PENDING' && owner === actorId)),
    }))));
  it.each(matrix)('enforces $role / $status / owner $owner', async ({ role, status, owner, allowed }) => {
    current.verificationStatus = status;
    current.createdById = owner;
    const response = await patch(undefined, role);
    expect(response.status).toBe(allowed ? 200 : 403);
    if (!allowed) expectNoWrites();
    else {
      expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
        where: { id, deletedAt: null, version: 3, verificationStatus: status,
          ...(role === 'EDITOR' ? { createdById: actorId } : {}) },
        data: { title: 'Updated', sourceType: undefined, author: undefined, publisher: undefined,
          year: undefined, url: undefined, citationText: undefined,
          updatedById: actorId, version: { increment: 1 } },
        select,
      });
      expect(response.body.data).toMatchObject({ title: 'Updated', version: 4, verificationStatus: status });
      expect(response.body.data).not.toHaveProperty('createdById');
      expect(mocks.audit).toHaveBeenCalledTimes(1);
    }
  });

  it('reads, updates and records selected before/after snapshots using only the transaction client', async () => {
    const response = await patch().set('X-Request-Id', 'source-update-123');
    expect(response.status).toBe(200);
    const updated = { ...current, title: 'Updated', version: 4, updatedAt: new Date('2026-11-04T00:00:00Z') };
    expect(response.body).toEqual({ data: JSON.parse(JSON.stringify(publicRow(updated))) });
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith({ where: { id, deletedAt: null }, select: { ...select, createdById: true } });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledExactlyOnceWith({ data: {
      entityType: 'Source', entityId: id, action: AuditAction.UPDATE, actorId,
      requestId: 'source-update-123', before: snapshot(current), after: snapshot(updated),
    } });
    expect(mocks.rootRead).not.toHaveBeenCalled();
    expect(mocks.rootUpdate).not.toHaveBeenCalled();
    expect(mocks.rootAudit).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Bearer invalid'])('requires authentication (%s)', async authorization => {
    const req = request(app).patch(`/api/v1/sources/${id}`);
    if (authorization) req.set('Authorization', authorization);
    expect((await req.send({ expectedVersion: 3, title: 'Updated' })).status).toBe(401);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('rejects unsupported token roles', async () => {
    expect((await patch(undefined, 'VIEWER')).status).toBe(401);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([
    {}, { title: 'Updated' }, { expectedVersion: 3 },
    ...[0, -1, 1.5, '3', null].map(expectedVersion => ({ expectedVersion, title: 'Updated' })),
    ...['', '  ', null, 123].map(title => ({ expectedVersion: 3, title })),
    ...['INVALID', null].map(sourceType => ({ expectedVersion: 3, sourceType })),
    ...[0, 1.5, '2020', new Date().getUTCFullYear() + 2].map(year => ({ expectedVersion: 3, year })),
    ...['invalid', 'ftp://example.invalid', 'javascript:alert(1)',
      'https://synthetic-user@example.invalid', 'https://:synthetic-password@example.invalid',
      'http://synthetic-user:synthetic-password@example.invalid',
      'https://%73ynthetic:%70assword@example.invalid'].map(url => ({ expectedVersion: 3, url })),
    ...['author', 'publisher', 'citationText'].map(field => ({ expectedVersion: 3, [field]: 123 })),
    ...['version', 'id', 'createdById', 'updatedById', 'verificationStatus', 'deletedAt', 'createdAt', 'updatedAt',
      'actorId', 'role', 'requestId', 'unknown'].map(field => ({ expectedVersion: 3, title: 'Updated', [field]: 1 })),
  ])('rejects invalid/unknown input %j before database access', async body => {
    const response = await patch(body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(mocks.transaction).not.toHaveBeenCalled();
    expectNoWrites();
  });
  it('validates UUIDs before database access', async () => {
    expect((await patch(undefined, 'EDITOR', 'invalid-id')).status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([1, new Date().getUTCFullYear() + 1])('updates all fields, trims title and accepts year %s', async year => {
    const fields = { title: 'Updated', sourceType: SourceType.ARTICLE, author: 'New Author',
      publisher: 'New Publisher', year, url: 'http://example.invalid/new', citationText: 'New Citation' };
    const response = await patch({ expectedVersion: 3, ...fields, title: '  Updated  ' });
    expect(response.status).toBe(200);
    expect(mocks.update.mock.calls[0]?.[0].data).toEqual({ ...fields, updatedById: actorId, version: { increment: 1 } });
    expect(response.body.data).toMatchObject({ ...fields, version: 4 });
    expect(mocks.audit.mock.calls[0]?.[0].data.after).toEqual({ ...snapshot(current), ...fields, version: 4 });
  });
  it.each(Object.values(SourceType))('persists and audits actual SourceType %s', async sourceType => {
    const response = await patch({ expectedVersion: 3, sourceType, title: 'Updated' });
    expect(response.status).toBe(200);
    expect(mocks.update.mock.calls[0]?.[0].data.sourceType).toBe(sourceType);
    expect(response.body.data.sourceType).toBe(sourceType);
    expect(mocks.audit.mock.calls[0]?.[0].data.after.sourceType).toBe(sourceType);
  });
  it.each(['author', 'publisher', 'year', 'url', 'citationText'])('clears nullable %s without changing omitted fields', async field => {
    const response = await patch({ expectedVersion: 3, [field]: null });
    expect(response.status).toBe(200);
    expect(mocks.update.mock.calls[0]?.[0].data[field]).toBeNull();
    expect(response.body.data).toEqual({ ...JSON.parse(JSON.stringify(publicRow(current))),
      [field]: null, version: 4, updatedAt: '2026-11-04T00:00:00.000Z' });
    expect(mocks.audit.mock.calls[0]?.[0].data.after).toEqual({ ...snapshot(current), [field]: null, version: 4 });
  });

  it('returns an authorized current-version no-op without version/timestamp changes or Audit', async () => {
    const response = await patch({ expectedVersion: 3, title: '  Original  ', year: 2020 });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: JSON.parse(JSON.stringify(publicRow(current))) });
    expectNoWrites();
  });
  it('treats null-to-null as a no-op', async () => {
    current.url = null;
    expect((await patch({ expectedVersion: 3, url: null })).status).toBe(200);
    expectNoWrites();
  });
  it('enforces ownership for no-ops', async () => {
    current.createdById = otherId;
    expect((await patch({ expectedVersion: 3, title: current.title })).status).toBe(403);
    expectNoWrites();
  });
  it.each(roles)('rejects REJECTED no-ops for %s', async role => {
    current.verificationStatus = 'REJECTED';
    expect((await patch({ expectedVersion: 3, title: current.title }, role)).status).toBe(403);
    expectNoWrites();
  });
  it.each(['Updated', 'Original'])('rejects stale versions even for title %s', async title => {
    const response = await patch({ expectedVersion: 2, title });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
    expectNoWrites();
  });
  it.each(['missing', 'soft-deleted'])('returns 404 for %s records', async state => {
    if (state === 'soft-deleted') current.deletedAt = new Date('2026-11-03T00:00:00Z');
    const lookupId = state === 'missing' ? otherId : id;
    const response = await patch(undefined, 'EDITOR', lookupId);
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Source not found' });
    expect(mocks.read.mock.calls[0]?.[0].where).toEqual({ id: lookupId, deletedAt: null });
    expectNoWrites();
  });
  it('maps a conditional update miss after the read to 409, without Audit', async () => {
    mocks.update.mockRejectedValue({ code: 'P2025' });
    const response = await patch();
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    { role: 'EDITOR', change: { version: 4 } },
    { role: 'EDITOR', change: { createdById: otherId } },
    { role: 'EDITOR', change: { verificationStatus: VerificationStatus.VERIFIED } },
    { role: 'EDITOR', change: { deletedAt: new Date('2026-11-03T00:00:00Z') } },
    { role: 'REVIEWER', change: { verificationStatus: VerificationStatus.REJECTED } },
    { role: 'ADMIN', change: { verificationStatus: VerificationStatus.VERIFIED } },
  ])('rejects a simulated $role race with $change using conditional predicates', async ({ role, change }) => {
    const applyUpdate = mocks.update.getMockImplementation()!;
    mocks.update.mockImplementation(async args => {
      Object.assign(current, change);
      return applyUpdate(args);
    });
    const response = await patch(undefined, role);
    expect(response.status).toBe(409);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.rootUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['https://synthetic-user:synthetic-password@example.invalid/old?token=synthetic-token#synthetic-fragment', 'https://example.invalid/old'],
    ['https://example.invalid/old?API_KEY=synthetic-key&access_token=synthetic-token&signature=synthetic-signature&safe=visible', 'https://example.invalid/old'],
    ['malformed legacy synthetic URL?password=synthetic-password', null],
    ['ftp://synthetic-user:synthetic-password@example.invalid/old', null],
    [null, null],
  ])('sanitizes legacy URL %s in before Audit and query strings in after Audit', async (url, safeUrl) => {
    current.url = url;
    const nextUrl = 'https://example.invalid/new?client_secret=synthetic-secret&token=synthetic-token#synthetic-fragment';
    const response = await patch({ expectedVersion: 3, url: nextUrl });
    expect(response.status).toBe(200);
    // Audit redaction does not silently change persisted content or the response contract.
    expect(mocks.update.mock.calls[0]?.[0].data.url).toBe(nextUrl);
    expect(response.body.data.url).toBe(nextUrl);
    const audit = mocks.audit.mock.calls[0]?.[0].data;
    expect(audit.before).toEqual({ ...snapshot(current), url: safeUrl });
    expect(audit.after).toEqual({ ...snapshot(current), url: 'https://example.invalid/new', version: 4 });
    expect(JSON.stringify(audit)).not.toMatch(/synthetic-user|synthetic-password|synthetic-token|synthetic-key|synthetic-signature|synthetic-secret|synthetic-fragment/);
  });

  it.each(['read', 'update', 'audit', 'transaction'] as const)('propagates %s failures through the shared handler', async operation => {
    mocks[operation].mockRejectedValue(new Error('synthetic-private-database-error'));
    const response = await patch();
    expect(response.status).toBe(500);
    expect(response.body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
    expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
    expect(JSON.stringify(response.body)).not.toContain('synthetic-private-database-error');
    if (operation === 'read' || operation === 'transaction') expectNoWrites();
    if (operation === 'update') expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('rejects the transaction callback with the original Audit failure (mock evidence, not PostgreSQL rollback)', async () => {
    const failure = new Error('synthetic Audit failure');
    mocks.audit.mockRejectedValue(failure);
    const { sourceService } = await import('../src/modules/sources/sources.service.js');
    await expect(sourceService.update(id, { expectedVersion: 3, title: 'Updated' },
      { actorId, role: 'EDITOR', requestId: 'synthetic-request' })).rejects.toBe(failure);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.read.mock.invocationCallOrder[0]).toBeLessThan(mocks.update.mock.invocationCallOrder[0]!);
    expect(mocks.update.mock.invocationCallOrder[0]).toBeLessThan(mocks.audit.mock.invocationCallOrder[0]!);
    expect(mocks.rootAudit).not.toHaveBeenCalled();
  });
});
