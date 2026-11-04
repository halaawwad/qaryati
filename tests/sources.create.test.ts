import { AuditAction, Prisma, SourceType } from '@prisma/client';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sourceCreate: vi.fn(), auditCreate: vi.fn(), transaction: vi.fn(),
  rootSourceCreate: vi.fn(), rootAuditCreate: vi.fn(),
}));
vi.mock('../src/shared/db.js', () => ({ prisma: {
  source: { create: mocks.rootSourceCreate },
  auditLog: { create: mocks.rootAuditCreate },
  $transaction: mocks.transaction,
} }));
vi.mock('../src/shared/cache.js', () => ({ redis: {} }));

const tx = { source: { create: mocks.sourceCreate }, auditLog: { create: mocks.auditCreate } };
const actorId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const secret = 'test-secret-with-at-least-32-characters';
const input = { title: 'Reference', sourceType: SourceType.BOOK };
const result = {
  id, ...input, author: null, publisher: null, year: null, url: null, citationText: null,
  verificationStatus: 'PENDING', version: 1,
  createdAt: new Date('2026-11-04T00:00:00Z'), updatedAt: new Date('2026-11-04T00:00:00Z'),
};
let app: Express;
beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('LOG_LEVEL', 'silent');
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('JWT_ACCESS_SECRET', secret);
  app = (await import('../src/app.js')).createApp();
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation((fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  mocks.sourceCreate.mockResolvedValue(result);
  mocks.auditCreate.mockResolvedValue({ id: 'audit-id' });
});
function post(body: unknown = input, role = 'EDITOR') {
  const token = jwt.sign({ role }, secret, { subject: actorId, algorithm: 'HS256', expiresIn: '15m' });
  return request(app).post('/api/v1/sources').set('Authorization', `Bearer ${token}`).send(body);
}

describe('POST Sources', () => {
  it.each(['EDITOR', 'REVIEWER', 'ADMIN'])('allows %s and returns 201 with selected data', async (role) => {
    const response = await post({ ...input, title: '  Reference  ' }, role).set('X-Request-Id', 'source-create-123');
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: JSON.parse(JSON.stringify(result)) });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.sourceCreate).toHaveBeenCalledExactlyOnceWith({
      data: {
        ...input, author: undefined, publisher: undefined, year: undefined, url: undefined,
        citationText: undefined, createdById: actorId, updatedById: actorId,
      },
      select: {
        id: true, title: true, author: true, publisher: true, year: true, url: true,
        sourceType: true, citationText: true, verificationStatus: true, version: true,
        createdAt: true, updatedAt: true,
      },
    });
    expect(mocks.auditCreate).toHaveBeenCalledExactlyOnceWith({ data: {
      entityType: 'Source', entityId: id, action: AuditAction.CREATE,
      actorId, requestId: 'source-create-123', before: Prisma.DbNull,
      after: {
        id, ...input, author: null, publisher: null, year: null, url: null, citationText: null,
        verificationStatus: 'PENDING', version: 1,
      },
    } });
    expect(mocks.rootSourceCreate).not.toHaveBeenCalled();
    expect(mocks.rootAuditCreate).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Bearer invalid'])('requires authentication (%s)', async (authorization) => {
    const req = request(app).post('/api/v1/sources');
    if (authorization) req.set('Authorization', authorization);
    expect((await req.send(input)).status).toBe(401);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects tokens with an unsupported role', async () => {
    expect((await post(input, 'VIEWER')).status).toBe(401);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([
    {}, { sourceType: 'BOOK' }, { title: 'Reference' }, { ...input, title: '   ' },
    { ...input, title: 123 }, { ...input, sourceType: 'INVALID' },
    ...[0, -1, 1.5, new Date().getUTCFullYear() + 2, '2020'].map(year => ({ ...input, year })),
    ...['invalid', 'ftp://example.com', 'javascript:alert(1)', 'file:///tmp/source'].map(url => ({ ...input, url })),
    ...['author', 'publisher', 'citationText'].map(field => ({ ...input, [field]: 123 })),
    ...['id', 'createdById', 'updatedById', 'verificationStatus', 'version', 'deletedAt',
      'createdAt', 'updatedAt', 'actorId', 'requestId', 'createdBy', 'auditLogs'].map(field => ({ ...input, [field]: 'spoofed' })),
  ])('rejects invalid or server-managed body %j before writing', async (body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([1, new Date().getUTCFullYear() + 1])('accepts year boundary %s and optional fields', async (year) => {
    const body = { ...input, year, author: 'Author', publisher: 'Publisher',
      url: 'https://example.com/reference', citationText: 'Citation' };
    expect((await post(body)).status).toBe(201);
    expect(mocks.sourceCreate.mock.calls[0]?.[0].data).toEqual({ ...body, createdById: actorId, updatedById: actorId });
  });

  it.each(Object.values(SourceType))('accepts actual SourceType %s', async (sourceType) => {
    expect((await post({ ...input, sourceType, url: 'http://example.com' })).status).toBe(201);
  });

  it('generates a request ID when absent and uses it for the audit', async () => {
    const response = await post();
    expect(response.status).toBe(201);
    expect(mocks.auditCreate.mock.calls[0]?.[0].data.requestId).toBe(response.headers['x-request-id']);
  });

  it.each(['source', 'audit'])('propagates %s errors to the shared HTTP handler', async (operation) => {
    (operation === 'source' ? mocks.sourceCreate : mocks.auditCreate).mockRejectedValue(new Error('private database detail'));
    const response = await post();
    expect(response.status).toBe(500);
    expect(response.body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
    expect(JSON.stringify(response.body)).not.toContain('private database detail');
    if (operation === 'source') expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('rejects the transaction callback on audit failure (rollback design, not real database rollback)', async () => {
    const failure = new Error('Audit unavailable');
    mocks.auditCreate.mockRejectedValue(failure);
    const { sourceService } = await import('../src/modules/sources/sources.service.js');
    await expect(sourceService.create(input, { actorId, requestId: 'request-1' })).rejects.toBe(failure);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.sourceCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.sourceCreate.mock.invocationCallOrder[0]).toBeLessThan(mocks.auditCreate.mock.invocationCallOrder[0]!);
    // The mock only demonstrates awaited writes on one client and rejection of the callback.
    // Actual rollback is Prisma/database behavior and requires a database integration test.
  });
});
