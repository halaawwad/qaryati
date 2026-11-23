import { Prisma } from '@prisma/client';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ village: vi.fn(), source: vi.fn(), lock: vi.fn(), insert: vi.fn(), audit: vi.fn(), transaction: vi.fn() }));
vi.mock('../src/shared/db.js', () => ({ prisma: { village: { findFirst: mocks.village }, source: { findFirst: mocks.source }, $transaction: mocks.transaction } }));
vi.mock('../src/shared/cache.js', () => ({ redis: {} }));
const villageId = '11111111-1111-4111-8111-111111111111';
const sourceId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const id = '44444444-4444-4444-8444-444444444444';
const secret = 'test-secret-with-at-least-32-characters';
const body = { population: 100, referenceYear: 2021, sourceId };
const now = new Date('2026-01-01T00:00:00.000Z');
const tx = { $queryRaw: mocks.lock, source: { findFirst: mocks.source }, populationRecord: { create: mocks.insert }, auditLog: { create: mocks.audit } };
let app: Express;
beforeAll(async () => {
 vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('LOG_LEVEL', 'silent'); vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db'); vi.stubEnv('REDIS_URL', 'redis://localhost:6379'); vi.stubEnv('JWT_ACCESS_SECRET', secret); vi.stubEnv('RATE_LIMIT_ENABLED', 'false');
 app = (await import('../src/app.js')).createApp();
});
beforeEach(() => {
 vi.resetAllMocks();
 mocks.village.mockResolvedValue({ id: villageId }); mocks.source.mockResolvedValue({ id: sourceId, deletedAt: null });
 mocks.lock.mockImplementation(async (_query, value) => [{ id: value }]);
 mocks.transaction.mockImplementation(async fn => fn(tx));
 mocks.insert.mockImplementation(async ({ data, select }) => {
  const row: Record<string, unknown> = { ...data, id, referenceDate: data.referenceDate ?? null, notes: data.notes ?? null, createdAt: now, updatedAt: now };
  return Object.fromEntries(Object.keys(select).map(key => [key, row[key]]));
 });
 mocks.audit.mockResolvedValue({ id: 'audit' });
});
function post(input: unknown = body, role = 'EDITOR', parent = villageId) {
 const token = jwt.sign({ role }, secret, { subject: actorId, algorithm: 'HS256' });
 return request(app).post(`/api/v1/villages/${parent}/population-records`).set('Authorization', `Bearer ${token}`).send(input);
}
describe('create population record', () => {
 it.each(['EDITOR', 'REVIEWER', 'ADMIN'])('creates for %s with server defaults and audit', async role => {
  const result = await post(body, role).set('X-Request-Id', 'population-create');
  expect(result.status).toBe(201);
  expect(result.body.data).toMatchObject({ id, villageId, ...body, isEstimate: false, isPreferred: false, needsReview: false, verificationStatus: 'PENDING', version: 1, referenceDate: null, notes: null });
  for (const field of ['verifiedById', 'verifiedAt', 'createdById', 'updatedById']) expect(result.body.data).not.toHaveProperty(field);
  expect(mocks.insert.mock.calls[0][0].data).toMatchObject({ isPreferred: false, verificationStatus: 'PENDING', version: 1, createdById: actorId, updatedById: actorId });
  expect(mocks.audit.mock.calls[0][0].data).toMatchObject({ entityType: 'PopulationRecord', entityId: id, action: 'CREATE', actorId, requestId: 'population-create', after: { id, referenceDate: null, isPreferred: false } });
  expect(mocks.transaction).toHaveBeenCalledTimes(1);
  expect(mocks.lock).toHaveBeenCalledTimes(2);
  expect((mocks.lock.mock.calls[0][0] as TemplateStringsArray).join('')).toContain('FROM villages');
  expect((mocks.lock.mock.calls[1][0] as TemplateStringsArray).join('')).toContain('FROM sources');
  expect(mocks.lock.mock.invocationCallOrder[1]).toBeLessThan(mocks.insert.mock.invocationCallOrder[0]!);
  expect(mocks.insert.mock.invocationCallOrder[0]).toBeLessThan(mocks.audit.mock.invocationCallOrder[0]!);
 });
 it('accepts nullable date and optional flags, trims notes and does not require matching years', async () => {
  const result = await post({ ...body, referenceDate: '2019-05-01T00:00:00Z', isEstimate: true, needsReview: true, notes: '  note  ' });
  expect(result.status).toBe(201); expect(result.body.data).toMatchObject({ referenceDate: '2019-05-01T00:00:00.000Z', isEstimate: true, needsReview: true, notes: 'note' });
  expect(mocks.audit.mock.calls[0][0].data.after.referenceDate).toBe('2019-05-01T00:00:00.000Z');
  expect((await post({ ...body, referenceDate: null, notes: null })).status).toBe(201);
 });
 it.each([{ population: 0 }, { population: 2147483648 }, { population: 1.5 }, { referenceYear: 1799 }, { referenceYear: 2101 }, { sourceId: 'bad' }, { referenceDate: 'bad' }, { isPreferred: true }, { isPreferred: false }, { notes: 'x'.repeat(5001) }, { verificationStatus: 'VERIFIED' }, { createdById: actorId }, { needsReview: 'false' }])('rejects invalid input %j', async changes => {
  expect((await post({ ...body, ...changes })).status).toBe(400); expect(mocks.transaction).not.toHaveBeenCalled();
 });
 it.each([1, 2147483647])('accepts population boundary %i', async population => { expect((await post({ ...body, population })).status).toBe(201); });
 it.each([1800, 2100])('accepts year boundary %i', async referenceYear => { expect((await post({ ...body, referenceYear })).status).toBe(201); });
 it('requires authentication before validation', async () => { expect((await request(app).post(`/api/v1/villages/${villageId}/population-records`).send({})).status).toBe(401); expect(mocks.transaction).not.toHaveBeenCalled(); });
 it.each(['village', 'source'])('rejects missing or deleted %s', async entity => {
  (entity === 'village' ? mocks.village : mocks.source).mockResolvedValue(null);
  expect((await post()).status).toBe(404); expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.insert).not.toHaveBeenCalled();
 });
 it.each([1, 2])('rejects reference deleted before lock %i', async position => {
  if (position === 2) mocks.lock.mockResolvedValueOnce([{ id: villageId }]);
  mocks.lock.mockResolvedValueOnce([]);
  expect((await post()).status).toBe(404); expect(mocks.insert).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
 });
 it.each([
  { modelName: 'PopulationRecord', target: ['village_id', 'reference_year', 'source_id'] },
  { modelName: 'PopulationRecord', target: ['sourceId', 'villageId', 'referenceYear'] },
  { modelName: 'PopulationRecord', target: 'population_records_village_id_reference_year_source_id_key' },
 ])('translates recognized business-key uniqueness metadata %j', async meta => {
  mocks.insert.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '6.19.3', meta }));
  expect((await post()).status).toBe(409); expect(mocks.audit).not.toHaveBeenCalled();
 });
 it.each([
  undefined,
  { modelName: 'PopulationRecord', target: ['id'] },
  { modelName: 'PopulationRecord', target: ['other'] },
  { modelName: 'PopulationRecord', target: 'population_records_one_preferred_per_year_idx' },
  { modelName: 'Other', target: ['village_id', 'reference_year', 'source_id'] },
  { modelName: 'PopulationRecord', target: ['village_id', 'reference_year', 'source_id', 'id'] },
 ])('does not translate unrecognized uniqueness metadata %j', async meta => {
  mocks.insert.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '6.19.3', meta }));
  expect((await post()).status).toBe(500); expect(mocks.audit).not.toHaveBeenCalled();
 });
 it.each(['insert', 'audit'])('propagates %s failure and rejects the transaction', async operation => {
  (operation === 'insert' ? mocks.insert : mocks.audit).mockRejectedValue(new Error('private database failure'));
  const response = await post(); expect(response.status).toBe(500); expect(JSON.stringify(response.body)).not.toContain('private database failure');
 });
 it('does not translate audit uniqueness failures into population conflicts', async () => {
  mocks.audit.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '6.19.3' }));
  expect((await post()).status).toBe(500);
 });
 it('awaits the audit in the transaction and rejects its callback on audit failure', async () => {
  const failure = new Error('audit failed');
  let callbackCompleted = false;
  mocks.transaction.mockImplementation(async fn => { const result = await fn(tx); callbackCompleted = true; return result; });
  mocks.audit.mockRejectedValue(failure);
  const { populationService } = await import('../src/modules/population/population.service.js');
  await expect(populationService.create(villageId, { ...body, isEstimate: false, needsReview: false }, { actorId, requestId: 'request' })).rejects.toBe(failure);
  expect(mocks.insert).toHaveBeenCalledOnce(); expect(mocks.audit).toHaveBeenCalledOnce();
  expect(mocks.insert.mock.invocationCallOrder[0]).toBeLessThan(mocks.audit.mock.invocationCallOrder[0]!);
  expect(callbackCompleted).toBe(false);
 });
});
