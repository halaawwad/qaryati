import { Prisma, type Village } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VillageGeoService } from '../src/modules/villages/villages.geo.service.js';
import { VillageService } from '../src/modules/villages/villages.service.js';
import { villageRepository } from '../src/modules/villages/villages.repository.js';
import { GeoCandidateStore } from '../src/integrations/geo/geo.store.js';
import type { GeoCandidate } from '../src/integrations/geo/geo.provider.js';

const db = vi.hoisted(() => ({ read: vi.fn(), detail: vi.fn(), update: vi.fn(), audit: vi.fn(), lock: vi.fn(), transaction: vi.fn() }));
vi.mock('../src/shared/db.js', () => ({ prisma: {
  village: { findFirst: db.detail }, $transaction: db.transaction,
} }));
vi.mock('../src/integrations/geo/index.js', () => ({ getGeoIntegration: vi.fn() }));
const tx = { village: { findUnique: db.read, updateMany: db.update }, auditLog: { create: db.audit }, $queryRaw: db.lock };
const id = '11111111-1111-4111-8111-111111111111';
const context = { actorId: '22222222-2222-4222-8222-222222222222', role: 'REVIEWER' as const, requestId: 'geo-request' };
const candidate: GeoCandidate = { latitude: 31.1234567, longitude: 35.1234567, displayName: 'Fixture location',
  provider: 'test', providerReference: 'node/123', address: { country_code: 'ps' }, match: { name: 'exact', governorate: 'unconfirmed' } };
let row: Village | null;
let service: VillageGeoService;
let candidates: GeoCandidateStore;
let provider: { cacheIdentity: string; lookup: ReturnType<typeof vi.fn> };
let villages: VillageService;
const governorate = { id, nameAr: 'بيت لحم', nameEn: 'Bethlehem', code: 'BTH' };
beforeEach(() => {
  vi.resetAllMocks();
  row = { id, nameAr: 'بتير', nameEn: 'Battir', governorateId: id, slug: 'battir',
    latitude: null, longitude: null, geoDisplayName: null, geoEnrichedAt: null, deletedAt: null,
    version: 1, verificationStatus: 'VERIFIED', updatedAt: new Date(), createdAt: new Date(),
    pcbsCode: null, localAuthorityId: null, nameOrigin: null, nameOriginSourceId: null,
    elevationM: null, areaDunums: null, locationDescription: null, historicalOverview: null, createdById: null, updatedById: null };
  db.detail.mockImplementation(async () => row && !row.deletedAt ? { ...row, governorate, localAuthority: null, nameOriginSource: null, names: [] } : null);
  db.read.mockImplementation(async () => row && { ...row });
  db.lock.mockResolvedValue([{ id }]);
  db.update.mockImplementation(async ({ where, data }) => {
    if (!row || row.deletedAt || row.version !== where.version) return { count: 0 };
    row = { ...row, ...data, version: row.version + 1,
      latitude: new Prisma.Decimal(Number(data.latitude.toFixed(6))), longitude: new Prisma.Decimal(Number(data.longitude.toFixed(6))) };
    return { count: 1 };
  });
  db.audit.mockResolvedValue({});
  // Commit/rollback wiring is mocked; SQL predicates and lock calls use the real repository.
  db.transaction.mockImplementation(async fn => {
    const before = row && { ...row };
    try { return await fn(tx); } catch (error) { row = before; throw error; }
  });
  const cache = new Map<string, string>();
  candidates = new GeoCandidateStore({ get: async key => cache.get(key) ?? null, put: async (key, value) => { cache.set(key, value); } }, 900);
  provider = { cacheIdentity: 'test', lookup: vi.fn().mockResolvedValue([candidate]) };
  villages = new VillageService(villageRepository);
  vi.spyOn(villages, 'applyGeoEnrichment');
  service = new VillageGeoService(villages, () => ({ provider, candidates }));
});
const select = async () => {
  const response = await service.candidates(id);
  return { candidateRef: response.candidates[0]!.candidateRef, version: response.version, confirm: true as const, overwriteExisting: false };
};

describe('reviewed Geo delegates to the existing VillageService and repository', () => {
  it('returns candidates without writing and preserves unconfirmed governorate review', async () => {
    expect(await service.candidates(id)).toMatchObject({ status: 'candidates_found', version: 1, candidates: [expect.objectContaining({ ...candidate })] });
    expect(db.update).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled();
  });
  it.each([0, 2])('reports %i matches without selecting', async count => {
    provider.lookup.mockResolvedValue(Array.from({ length: count }, () => candidate));
    expect((await service.candidates(id)).status).toBe(count ? 'ambiguous' : 'no_match');
  });
  it('applies through the shared service, resets status and writes exactly one lowercase village audit', async () => {
    const input = await select();
    const result = await service.apply(id, input, context);
    expect(result).toMatchObject({ id, latitude: 31.123457, longitude: 35.123457, version: 2, verificationStatus: 'PENDING', updatedAt: expect.any(Date) });
    expect(villages.applyGeoEnrichment).toHaveBeenCalledExactlyOnceWith(id,
      { latitude: candidate.latitude, longitude: candidate.longitude, geoDisplayName: candidate.displayName },
      expect.objectContaining({ actor: { id: context.actorId, role: context.role }, expectedVersion: 1, overwrite: false, requestId: context.requestId }));
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.lock.mock.calls[0]![0].join('?')).toContain('FOR UPDATE');
    expect(db.update).toHaveBeenCalledWith({ where: { id, version: 1, deletedAt: null }, data: expect.objectContaining({
      verificationStatus: 'PENDING', version: { increment: 1 }, updatedById: context.actorId,
    }) });
    expect(db.audit).toHaveBeenCalledTimes(1);
    expect(db.audit.mock.calls[0]![0].data).toMatchObject({ entityType: 'village', entityId: id, action: 'UPDATE', actorId: context.actorId,
      requestId: context.requestId, before: { verificationStatus: 'VERIFIED', version: 1 },
      after: { latitude: '31.123457', version: 2, verificationStatus: 'PENDING', source: 'geo-enrichment',
        provenance: { candidateRef: input.candidateRef, provider: 'test', providerReference: 'node/123', confirmed: true } } });
  });
  it('rolls back the update when the shared audit fails', async () => {
    const input = await select(); const before = { ...row! }; db.audit.mockRejectedValueOnce(new Error('audit failed'));
    await expect(service.apply(id, input, context)).rejects.toThrow('audit failed'); expect(row).toEqual(before);
  });
  it('maps shared skipped result to overwrite conflict without writing or auditing', async () => {
    row!.latitude = new Prisma.Decimal(0); const input = await select();
    await expect(service.apply(id, input, context)).rejects.toMatchObject({ statusCode: 409 });
    expect(db.update).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled();
    expect((await service.apply(id, { ...input, overwriteExisting: true }, context)).version).toBe(2);
  });
  it.each(['version', 'identity', 'client', 'replay'])('rejects stale selection via %s', async kind => {
    const input = await select();
    if (kind === 'version') row!.version++;
    if (kind === 'identity') row!.nameAr = 'Changed';
    if (kind === 'client') input.version++;
    if (kind === 'replay') await service.apply(id, input, context);
    await expect(service.apply(id, input, context)).rejects.toMatchObject({ statusCode: 409 });
    expect(db.audit).toHaveBeenCalledTimes(kind === 'replay' ? 1 : 0);
  });
  it.each(['missing', 'expired', 'foreign', 'country'])('rejects %s candidate', async kind => {
    const input = await select();
    if (kind === 'missing') input.candidateRef = context.actorId;
    else {
      const record = (await candidates.read(input.candidateRef))!;
      const other = await candidates.issue({ ...record, villageId: kind === 'foreign' ? context.actorId : id,
        candidate: kind === 'country' ? { ...candidate, address: { country_code: 'us' } } : candidate });
      input.candidateRef = other.candidateRef;
    }
    const clock = kind === 'expired' ? vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 901000) : undefined;
    try { await expect(service.apply(id, input, context)).rejects.toMatchObject({ code: 'INVALID_GEO_CANDIDATE' }); }
    finally { clock?.mockRestore(); }
    expect(db.update).not.toHaveBeenCalled();
  });
  it('rechecks expiry after waiting for the shared write lock', async () => {
    const input = await select(); let clock: ReturnType<typeof vi.spyOn> | undefined;
    db.lock.mockImplementationOnce(async () => { clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 901000); return [{ id }]; });
    try { await expect(service.apply(id, input, context)).rejects.toMatchObject({ code: 'INVALID_GEO_CANDIDATE' }); }
    finally { clock?.mockRestore(); }
    expect(db.update).not.toHaveBeenCalled(); expect(db.audit).not.toHaveBeenCalled();
  });
  it.each(['deleted', 'version'])('rechecks %s inside the shared transaction', async kind => {
    const input = await select();
    db.lock.mockImplementationOnce(async () => { if (kind === 'deleted') row!.deletedAt = new Date(); else row!.version++; return []; });
    await expect(service.apply(id, input, context)).rejects.toMatchObject({ statusCode: kind === 'deleted' ? 404 : 409 });
    expect(db.audit).not.toHaveBeenCalled();
  });
  it('preserves the guarded update conflict check', async () => {
    const input = await select(); db.update.mockResolvedValueOnce({ count: 0 });
    await expect(service.apply(id, input, context)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(db.audit).not.toHaveBeenCalled();
  });
  it('rechecks identity or deletion after provider lookup', async () => {
    provider.lookup.mockImplementationOnce(async () => { row!.version++; return [candidate]; });
    await expect(service.candidates(id)).rejects.toMatchObject({ statusCode: 409 });
    provider.lookup.mockImplementationOnce(async () => { row = null; return [candidate]; });
    await expect(service.candidates(id)).rejects.toMatchObject({ statusCode: 404 });
  });
  it('requires reviewer/admin authorization and confirmation', async () => {
    const input = await select();
    await expect(service.apply(id, input, { ...context, role: 'EDITOR' })).rejects.toMatchObject({ statusCode: 403 });
    expect(db.update).not.toHaveBeenCalled();
  });
  it('uses the shared display name validation instead of silently truncating', async () => {
    provider.lookup.mockResolvedValue([{ ...candidate, displayName: 'x'.repeat(501) }]);
    await expect(service.apply(id, await select(), context)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(db.update).not.toHaveBeenCalled();
  });
});
