import { AuditAction, LandmarkType, Prisma, Role, VerificationStatus } from '@prisma/client';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LandmarkService } from '../src/modules/landmarks/landmarks.service.js';

const mocks = vi.hoisted(() => ({
  villageFind: vi.fn(), sourceFind: vi.fn(), landmarkCreate: vi.fn(), auditCreate: vi.fn(),
  transaction: vi.fn(), rootLandmarkCreate: vi.fn(), rootAuditCreate: vi.fn(),
  queryRaw: vi.fn(), txSourceFind: vi.fn(),
}));
vi.mock('../src/shared/db.js', () => ({ prisma: {
  village: { findFirst: mocks.villageFind },
  source: { findFirst: mocks.sourceFind },
  landmark: { create: mocks.rootLandmarkCreate },
  auditLog: { create: mocks.rootAuditCreate },
  $transaction: mocks.transaction,
} }));
vi.mock('../src/shared/cache.js', () => ({ redis: {} }));

const tx = {
  landmark: { create: mocks.landmarkCreate }, auditLog: { create: mocks.auditCreate },
  $queryRaw: mocks.queryRaw, source: { findFirst: mocks.txSourceFind },
};
const villageId = '11111111-1111-4111-8111-111111111111';
const sourceId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const landmarkId = '44444444-4444-4444-8444-444444444444';
const secret = 'test-secret-with-at-least-32-characters';
const input = { nameAr: 'عين البلد', landmarkType: LandmarkType.SPRING, sourceId };
const timestamp = new Date('2026-11-04T00:00:00Z');
let app: Express;
let service: LandmarkService;
let village: { id: string; deletedAt: Date | null } | null;
let source: { id: string; deletedAt: Date | null; verificationStatus: VerificationStatus } | null;
let committedLandmarks: unknown[];
let committedAudits: unknown[];
let stagedLandmarks: unknown[];
let stagedAudits: unknown[];

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('LOG_LEVEL', 'silent');
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('JWT_ACCESS_SECRET', secret);
  vi.stubEnv('RATE_LIMIT_ENABLED', 'false');
  app = (await import('../src/app.js')).createApp();
  service = (await import('../src/modules/landmarks/landmarks.service.js')).landmarkService;
});

beforeEach(() => {
  vi.resetAllMocks();
  village = { id: villageId, deletedAt: null };
  source = { id: sourceId, deletedAt: null, verificationStatus: VerificationStatus.PENDING };
  committedLandmarks = [];
  committedAudits = [];
  stagedLandmarks = [];
  stagedAudits = [];
  mocks.villageFind.mockImplementation(async ({ where }) =>
    village?.id === where.id && village.deletedAt === where.deletedAt ? village : null);
  mocks.sourceFind.mockImplementation(async ({ where }) =>
    source?.id === where.id && source.deletedAt === where.deletedAt ? source : null);
  mocks.txSourceFind.mockImplementation(async ({ where }) =>
    source?.id === where.id && source.deletedAt === where.deletedAt ? source : null);
  mocks.queryRaw.mockImplementation(async (query: TemplateStringsArray, id: string) => {
    const row = query.join('').includes('FROM villages') ? village : source;
    return row?.id === id && row.deletedAt === null ? [{ id }] : [];
  });
  // Model commit/discard to test transaction wiring. This is not a PostgreSQL integration test.
  mocks.transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => {
    stagedLandmarks = [];
    stagedAudits = [];
    const result = await fn(tx);
    committedLandmarks.push(...stagedLandmarks);
    committedAudits.push(...stagedAudits);
    return result;
  });
  mocks.landmarkCreate.mockImplementation(async ({ data, select }) => {
    const row: Record<string, unknown> = {
      ...data, id: landmarkId, nameEn: data.nameEn ?? null, description: data.description ?? null,
      latitude: data.latitude == null ? null : new Prisma.Decimal(data.latitude),
      longitude: data.longitude == null ? null : new Prisma.Decimal(data.longitude),
      verificationStatus: data.verificationStatus ?? VerificationStatus.PENDING,
      version: data.version ?? 1, deletedAt: null, createdAt: timestamp, updatedAt: timestamp,
    };
    stagedLandmarks.push(row);
    return Object.fromEntries(Object.keys(select).map(key => [key, row[key]]));
  });
  mocks.auditCreate.mockImplementation(async ({ data }) => {
    const row = { ...data, id: 'audit-id' };
    stagedAudits.push(row);
    return row;
  });
});

afterEach(() => {
  expect(mocks.rootLandmarkCreate).not.toHaveBeenCalled();
  expect(mocks.rootAuditCreate).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

function post(body: unknown = input, role = 'EDITOR', parentId = villageId) {
  const token = jwt.sign({ role }, secret, { subject: actorId, algorithm: 'HS256', expiresIn: '15m' });
  return request(app).post(`/api/v1/villages/${parentId}/landmarks`)
    .set('Authorization', `Bearer ${token}`).send(body);
}

function expectNoWrites() {
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.queryRaw).not.toHaveBeenCalled();
  expect(mocks.landmarkCreate).not.toHaveBeenCalled();
  expect(mocks.auditCreate).not.toHaveBeenCalled();
  expect(committedLandmarks).toEqual([]);
  expect(committedAudits).toEqual([]);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('POST /api/v1/villages/:villageId/landmarks', () => {
  it.each(Object.values(Role))('allows %s, uses the URL village and actor, and creates default metadata', async (role) => {
    const response = await post({ ...input, nameAr: `  ${input.nameAr}  ` }, role);
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: {
      id: landmarkId, villageId, ...input, nameEn: null, description: null,
      latitude: null, longitude: null, verificationStatus: 'PENDING', version: 1,
      createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString(),
    } });
    expect(mocks.landmarkCreate).toHaveBeenCalledExactlyOnceWith({
      data: {
        villageId, ...input, nameEn: undefined, description: undefined,
        latitude: undefined, longitude: undefined, createdById: actorId, updatedById: actorId,
      },
      select: {
        id: true, villageId: true, nameAr: true, nameEn: true, landmarkType: true,
        description: true, latitude: true, longitude: true, sourceId: true,
        verificationStatus: true, version: true, createdAt: true, updatedAt: true,
      },
    });
    expect(committedLandmarks).toEqual([expect.objectContaining({
      createdById: actorId, updatedById: actorId, verificationStatus: 'PENDING', version: 1, deletedAt: null,
    })]);
    expect(mocks.villageFind).toHaveBeenCalledExactlyOnceWith({
      where: { id: villageId, deletedAt: null }, select: { id: true },
    });
    expect(mocks.sourceFind).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      where: { id: sourceId, deletedAt: null },
    }));
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it('records a JSON-compatible CREATE snapshot and request ID on the same transaction client', async () => {
    const body = { ...input, nameEn: ' Village Spring ', description: ' A documented spring. ',
      latitude: 32.123456, longitude: 35.654321 };
    const response = await post(body).set('X-Request-Id', 'landmark-create-123');
    expect(response.status).toBe(201);
    const snapshot = {
      id: landmarkId, villageId, ...input, nameEn: 'Village Spring', description: 'A documented spring.',
      latitude: 32.123456, longitude: 35.654321, verificationStatus: 'PENDING', version: 1,
    };
    expect(response.body.data).toEqual({ ...snapshot,
      createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString(),
    });
    expect(mocks.auditCreate).toHaveBeenCalledExactlyOnceWith({ data: {
      entityType: 'Landmark', entityId: landmarkId, action: AuditAction.CREATE,
      actorId, requestId: 'landmark-create-123', before: Prisma.DbNull, after: snapshot,
    } });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(committedAudits).toHaveLength(1);
    expect(mocks.landmarkCreate.mock.invocationCallOrder[0]).toBeLessThan(mocks.auditCreate.mock.invocationCallOrder[0]!);
  });

  it('uses the generated request ID for the audit when none is supplied', async () => {
    const response = await post();
    expect(response.status).toBe(201);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(mocks.auditCreate.mock.calls[0]?.[0].data.requestId).toBe(response.headers['x-request-id']);
  });

  it('locks active references on the write transaction in village/source order before inserting', async () => {
    expect((await post()).status).toBe(201);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(2);
    for (const [index, table, id] of [[0, 'villages', villageId], [1, 'sources', sourceId]] as const) {
      const [query, value] = mocks.queryRaw.mock.calls[index]!;
      expect((query as TemplateStringsArray).join('?').trim())
        .toBe(`SELECT id FROM ${table} WHERE id = ?::uuid AND deleted_at IS NULL FOR SHARE`);
      expect(value).toBe(id);
      expect(mocks.queryRaw.mock.invocationCallOrder[index]).toBeLessThan(mocks.landmarkCreate.mock.invocationCallOrder[0]!);
    }
    expect(mocks.txSourceFind).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      where: { id: sourceId, deletedAt: null },
    }));
  });

  it.each([
    ['village', 'missing'], ['village', 'deleted'], ['source', 'missing'], ['source', 'deleted'],
  ])('returns 404 without writes when the %s becomes %s after preflight', async (entity, state) => {
    const runTransaction = mocks.transaction.getMockImplementation()!;
    mocks.transaction.mockImplementationOnce((fn: (client: typeof tx) => Promise<unknown>) => {
      if (entity === 'village') {
        if (state === 'missing') village = null;
        else village!.deletedAt = timestamp;
      } else {
        if (state === 'missing') source = null;
        else source!.deletedAt = timestamp;
      }
      return runTransaction(fn);
    });
    const response = await post();
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({
      code: 'NOT_FOUND', message: entity === 'village' ? 'Village not found' : 'Source not found',
    });
    expect(mocks.villageFind).toHaveBeenCalledTimes(1);
    expect(mocks.sourceFind).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(entity === 'village' ? 1 : 2);
    expect(mocks.txSourceFind).not.toHaveBeenCalled();
    expect(mocks.landmarkCreate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(committedLandmarks).toEqual([]);
    expect(committedAudits).toEqual([]);
  });

  it('still accepts an active source whose version and verification status change before locking', async () => {
    const runTransaction = mocks.transaction.getMockImplementation()!;
    mocks.transaction.mockImplementationOnce((fn: (client: typeof tx) => Promise<unknown>) => {
      Object.assign(source!, { version: 2, verificationStatus: VerificationStatus.REJECTED });
      return runTransaction(fn);
    });
    expect((await post()).status).toBe(201);
    expect(committedLandmarks).toHaveLength(1);
    expect(committedAudits).toHaveLength(1);
  });

  it.each([1, 2])('propagates failure of reference lock %i without insert or audit', async (lock) => {
    if (lock === 2) mocks.queryRaw.mockResolvedValueOnce([{ id: villageId }]);
    mocks.queryRaw.mockRejectedValueOnce(new Error('private locking failure'));
    const response = await post();
    expect(response.status).toBe(500);
    expect(response.body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
    expect(mocks.landmarkCreate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(committedLandmarks).toEqual([]);
    expect(committedAudits).toEqual([]);
  });

  it.each(['insert', 'audit'])('does not mislabel an unrelated %s foreign-key failure as a missing reference', async (operation) => {
    const failure = new Prisma.PrismaClientKnownRequestError('private constraint detail', {
      code: 'P2003', clientVersion: '6.19.3', meta: { field_name: 'actor_id' },
    });
    (operation === 'insert' ? mocks.landmarkCreate : mocks.auditCreate).mockRejectedValueOnce(failure);
    const response = await post();
    expect(response.status).toBe(500);
    expect(response.body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
    expect(committedLandmarks).toEqual([]);
    expect(committedAudits).toEqual([]);
    if (operation === 'insert') expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it.each([
    { latitude: null, longitude: null }, { latitude: null }, { longitude: null },
    { latitude: 0, longitude: 0 }, { latitude: -90, longitude: -180 }, { latitude: 90, longitude: 180 },
  ])('creates with optional coordinates %j and omitted optional text', async (coordinates) => {
    const response = await post({ ...input, ...coordinates });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      nameEn: null, description: null, latitude: coordinates.latitude ?? null, longitude: coordinates.longitude ?? null,
    });
  });

  it.each(Object.values(VerificationStatus))('accepts an active %s source under the existing visibility policy', async (status) => {
    source!.verificationStatus = status;
    expect((await post()).status).toBe(201);
  });

  it.each([
    {}, { ...input, nameAr: undefined }, { ...input, nameAr: '   ' },
    { ...input, landmarkType: undefined }, { ...input, landmarkType: 'UNKNOWN' },
    ...[undefined, null, 'invalid'].map(sourceId => ({ ...input, sourceId })),
    ...['', '   ', null, 123].map(nameEn => ({ ...input, nameEn })),
    { ...input, nameAr: 'ع'.repeat(201) }, { ...input, nameEn: 'x'.repeat(201) },
    { ...input, description: 'x'.repeat(5001) },
    ...[{ latitude: 0 }, { longitude: 0 }, { latitude: null, longitude: 35 },
      { latitude: 32, longitude: null }, { latitude: 91, longitude: 35 },
      { latitude: 32, longitude: -181 }, { latitude: '32', longitude: 35 }]
      .map(coordinates => ({ ...input, ...coordinates })),
    ...['id', 'villageId', 'createdById', 'updatedById', 'verificationStatus', 'version',
      'deletedAt', 'createdAt', 'updatedAt', 'actorId', 'requestId', 'unexpected']
      .map(field => ({ ...input, [field]: 'spoofed' })),
  ])('rejects invalid input or protected fields before any lookup or write: %j', async (body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR', details: expect.any(Array) });
    expect(mocks.villageFind).not.toHaveBeenCalled();
    expect(mocks.sourceFind).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('rejects a malformed village UUID before querying', async () => {
    const response = await post(input, 'EDITOR', 'not-a-uuid');
    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'params.villageId' }),
    ]));
    expect(mocks.villageFind).not.toHaveBeenCalled();
    expect(mocks.sourceFind).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it.each(['missing', 'deleted'])('returns the standard 404 for a %s village before source lookup or writes', async (state) => {
    village = state === 'missing' ? null : { id: villageId, deletedAt: timestamp };
    const response = await post();
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Village not found' });
    expect(mocks.sourceFind).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it.each(['missing', 'deleted'])('returns the standard 404 for a %s source without writes', async (state) => {
    source = state === 'missing' ? null : { id: sourceId, deletedAt: timestamp, verificationStatus: VerificationStatus.PENDING };
    const response = await post();
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Source not found' });
    expectNoWrites();
  });

  it.each([undefined, 'Bearer invalid', 'Basic invalid'])('rejects unauthenticated requests (%s) before lookups', async (authorization) => {
    const req = request(app).post(`/api/v1/villages/${villageId}/landmarks`);
    if (authorization) req.set('Authorization', authorization);
    const response = await req.send(input);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(mocks.villageFind).not.toHaveBeenCalled();
    expect(mocks.sourceFind).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('rejects expired tokens without writes', async () => {
    const token = jwt.sign({ role: Role.EDITOR }, secret, { subject: actorId, expiresIn: '-1s' });
    const response = await request(app).post(`/api/v1/villages/${villageId}/landmarks`)
      .set('Authorization', `Bearer ${token}`).send(input);
    expect(response.status).toBe(401);
    expectNoWrites();
  });

  it('rejects unsupported token roles at authentication', async () => {
    expect((await post(input, 'VIEWER')).status).toBe(401);
    expectNoWrites();
  });

  it('returns 403 before validation or writes if authentication supplies a disallowed role', async () => {
    // All current Role values can create. Inject a future role to exercise the real route guard;
    // the real token verifier rejects unsupported roles with 401, covered above.
    const { authService } = await import('../src/modules/auth/auth.service.js');
    vi.spyOn(authService, 'verifyAccessToken').mockReturnValueOnce({ id: actorId, role: 'VIEWER' as Role });
    const response = await post({});
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(mocks.villageFind).not.toHaveBeenCalled();
    expect(mocks.sourceFind).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it.each(['village', 'source', 'insert', 'audit', 'transaction'])('handles %s database failure with a sanitized 500', async (operation) => {
    const failingMock = { village: mocks.villageFind, source: mocks.sourceFind,
      insert: mocks.landmarkCreate, audit: mocks.auditCreate, transaction: mocks.transaction }[operation]!;
    failingMock.mockRejectedValue(new Error('private database detail'));
    const response = await post().set('X-Request-Id', 'failed-create');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: {
      code: 'INTERNAL_ERROR', message: 'Internal server error', details: [], requestId: 'failed-create',
    } });
    expect(committedLandmarks).toEqual([]);
    expect(committedAudits).toEqual([]);
    if (operation !== 'audit') expect(mocks.auditCreate).not.toHaveBeenCalled();
    if (operation === 'village' || operation === 'source') expectNoWrites();
  });

  it('rejects the transaction on audit failure and preserves earlier commits in the transaction model', async () => {
    await service.create(villageId, input, { actorId, requestId: 'previous-create' });
    const previousLandmarks = [...committedLandmarks];
    const previousAudits = [...committedAudits];
    const failure = new Error('Audit unavailable');
    mocks.auditCreate.mockRejectedValueOnce(failure);
    await expect(service.create(villageId, input, { actorId, requestId: 'failed-create' })).rejects.toBe(failure);
    expect(mocks.landmarkCreate).toHaveBeenCalledTimes(2);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(2);
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(committedLandmarks).toEqual(previousLandmarks);
    expect(committedAudits).toEqual(previousAudits);
  });

  it('awaits audit completion and transaction commit before resolving creation', async () => {
    const auditStarted = deferred();
    const auditFinished = deferred();
    const commitStarted = deferred();
    const commitFinished = deferred();
    mocks.auditCreate.mockImplementationOnce(async () => {
      auditStarted.resolve();
      await auditFinished.promise;
      return { id: 'audit-id' };
    });
    mocks.transaction.mockImplementationOnce(async (fn: (client: typeof tx) => Promise<unknown>) => {
      const result = await fn(tx);
      commitStarted.resolve();
      await commitFinished.promise;
      return result;
    });
    const settled = vi.fn();
    const pending = service.create(villageId, input, { actorId, requestId: 'await-create' }).then(settled);
    await auditStarted.promise;
    expect(settled).not.toHaveBeenCalled();
    auditFinished.resolve();
    await commitStarted.promise;
    expect(settled).not.toHaveBeenCalled();
    commitFinished.resolve();
    await pending;
    expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: landmarkId }));
  });
});

describe('existing landmark GET routes', () => {
  it('still allows public listing with the existing data and pagination envelope', async () => {
    const meta = { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false };
    const list = vi.spyOn(service, 'list').mockResolvedValueOnce({ items: [], meta });
    const response = await request(app).get(`/api/v1/villages/${villageId}/landmarks`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [], meta });
    expect(list).toHaveBeenCalledExactlyOnceWith(villageId, {});
    expectNoWrites();
  });

  it('still allows public detail access with the existing data envelope', async () => {
    const landmark = {
      id: landmarkId, villageId, ...input, nameEn: null, description: null,
      latitude: null, longitude: null, verificationStatus: VerificationStatus.PENDING, version: 1,
      createdAt: timestamp, updatedAt: timestamp,
    };
    const getById = vi.spyOn(service, 'getById').mockResolvedValueOnce(landmark);
    const response = await request(app).get(`/api/v1/landmarks/${landmarkId}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: JSON.parse(JSON.stringify(landmark)) });
    expect(getById).toHaveBeenCalledExactlyOnceWith(landmarkId);
    expectNoWrites();
  });
});
