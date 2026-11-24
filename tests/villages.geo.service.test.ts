import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VillageGeoService } from '../src/modules/villages/villages.geo.service.js';
import type { VillageGeo, VillageGeoRepository } from '../src/modules/villages/villages.geo.repository.js';
import { GeoCandidateStore, geoIdentity } from '../src/integrations/geo/geo.store.js';
import type { GeoCandidate } from '../src/integrations/geo/geo.provider.js';
import type { recordAudit } from '../src/modules/audit/audit.service.js';
vi.mock('../src/shared/db.js', () => ({ prisma: {} }));
vi.mock('../src/integrations/geo/index.js', () => ({ getGeoIntegration: vi.fn() }));

const id = '11111111-1111-4111-8111-111111111111';
const context = { actorId: '22222222-2222-4222-8222-222222222222', requestId: 'geo-request' };
const candidate: GeoCandidate = { latitude: 31.1234567, longitude: 35.1234567, displayName: 'Fixture location',
  provider: 'test', providerReference: 'node/123', address: { country_code: 'ps' }, match: { name: 'exact', governorate: 'exact' } };
let stored: VillageGeo | null;
let service: VillageGeoService;
let candidates: GeoCandidateStore;
let provider: { cacheIdentity: string; lookup: ReturnType<typeof vi.fn> };
let audit: ReturnType<typeof vi.fn<typeof recordAudit>>;
let repo: VillageGeoRepository;
const tx = {} as Prisma.TransactionClient;
beforeEach(() => {
  stored = { id, nameAr: 'بتير', nameEn: 'Battir', governorate: { nameAr: 'بيت لحم', nameEn: 'Bethlehem' },
    latitude: null, longitude: null, geoDisplayName: null, geoEnrichedAt: null,
    version: 1, verificationStatus: 'VERIFIED', updatedAt: new Date() };
  const cache = new Map<string, string>();
  candidates = new GeoCandidateStore({ get: async key => cache.get(key) ?? null, put: async (key, value) => { cache.set(key, value); } }, 900);
  provider = { cacheIdentity: 'test', lookup: vi.fn().mockResolvedValue([candidate]) };
  audit = vi.fn<typeof recordAudit>().mockResolvedValue({} as never);
  repo = {
    find: vi.fn(async () => stored ? { ...stored } : null), lock: vi.fn().mockResolvedValue(undefined),
    transaction: async fn => { const before = stored && { ...stored }; try { return await fn(tx); } catch (error) { stored = before; throw error; } },
    apply: vi.fn(async (_id, version, update) => {
      if (!stored || version !== stored.version) return null;
      stored = { ...stored, latitude: Number(update.latitude.toFixed(6)), longitude: Number(update.longitude.toFixed(6)),
        geoDisplayName: update.geoDisplayName, geoEnrichedAt: update.geoEnrichedAt, version: version + 1 };
      return stored;
    }),
  };
  service = new VillageGeoService(repo, () => ({ provider, candidates }), audit);
});
const select = async () => {
  const response = await service.candidates(id);
  return { candidateRef: response.candidates[0]!.candidateRef, version: response.version, confirm: true as const, overwriteExisting: false };
};

describe('village geo enrichment service', () => {
  it('returns explicit candidates and does not write during lookup', async () => {
    const response = await service.candidates(id);
    expect(response).toMatchObject({ villageId: id, version: 1, status: 'candidates_found', candidates: [expect.objectContaining({ ...candidate, candidateRef: expect.any(String) })] });
    expect(provider.lookup).toHaveBeenCalledWith({ nameAr: 'بتير', nameEn: 'Battir', governorate: stored!.governorate, countryCode: 'ps' });
    expect(repo.apply).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
  });
  it.each([0, 2])('reports %i candidates without selecting any', async count => {
    provider.lookup.mockResolvedValue(Array.from({ length: count }, () => candidate));
    expect((await service.candidates(id)).status).toBe(count === 0 ? 'no_match' : 'ambiguous');
    expect(repo.apply).not.toHaveBeenCalled();
  });
  it('persists only geo fields and actor, uses stored precision, increments version and audits in the transaction', async () => {
    const input = await select(); const before = { ...stored! };
    const response = await service.apply(id, input, context);
    expect(response).toMatchObject({ id, latitude: 31.123457, longitude: 35.123457, geoDisplayName: candidate.displayName, version: 2, verificationStatus: 'VERIFIED' });
    expect(repo.lock).toHaveBeenCalledWith(id, tx);
    expect(repo.apply).toHaveBeenCalledWith(id, 1, expect.objectContaining({ actorId: context.actorId, latitude: candidate.latitude, geoEnrichedAt: expect.any(Date) }), tx);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'Village', entityId: id, action: 'UPDATE', ...context,
      before: expect.objectContaining({ latitude: null, longitude: null, version: 1 }),
      after: expect.objectContaining({ latitude: response.latitude, longitude: response.longitude,
        provenance: expect.objectContaining({ provider: 'test', providerReference: 'node/123', candidateRef: input.candidateRef, confirmed: true }) }),
    }), tx);
    expect(stored!.nameAr).toBe(before.nameAr); expect(stored!.governorate).toEqual(before.governorate);
  });
  it('rolls back on audit failure (transaction wiring)', async () => {
    const input = await select(); const before = { ...stored! }; audit.mockRejectedValue(new Error('audit failed'));
    await expect(service.apply(id, input, context)).rejects.toThrow('audit failed'); expect(stored).toEqual(before);
  });
  it('requires explicit overwrite for any existing coordinate including zero', async () => {
    stored!.latitude = 0; stored!.longitude = 0; const input = await select();
    await expect(service.apply(id, input, context)).rejects.toMatchObject({ statusCode: 409 });
    expect(repo.apply).not.toHaveBeenCalled();
    expect((await service.apply(id, { ...input, overwriteExisting: true }, context)).version).toBe(2);
  });
  it.each(['version', 'identity', 'replay'])('rejects stale candidate via %s', async kind => {
    const input = await select();
    if (kind === 'version') stored!.version++;
    if (kind === 'identity') stored!.nameAr = 'Changed';
    if (kind === 'replay') await service.apply(id, input, context);
    await expect(service.apply(id, input, context)).rejects.toMatchObject({ statusCode: 409 });
  });
  it('rejects altered client version', async () => {
    const input = await select(); await expect(service.apply(id, { ...input, version: 20 }, context)).rejects.toMatchObject({ statusCode: 409 });
    expect(repo.apply).not.toHaveBeenCalled();
  });
  it('rejects unknown, expired and another-village references', async () => {
    const input = await select();
    await expect(service.apply(id, { ...input, candidateRef: context.actorId }, context)).rejects.toMatchObject({ code: 'INVALID_GEO_CANDIDATE' });
    const other = await candidates.issue({ villageId: context.actorId, version: 1, identity: 'other', candidate });
    await expect(service.apply(id, { ...input, candidateRef: other.candidateRef }, context)).rejects.toMatchObject({ code: 'INVALID_GEO_CANDIDATE' });
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 901000);
    try { await expect(service.apply(id, input, context)).rejects.toMatchObject({ code: 'INVALID_GEO_CANDIDATE' }); }
    finally { now.mockRestore(); }
    expect(repo.apply).not.toHaveBeenCalled();
  });
  it('rechecks expiration after waiting for row lock', async () => {
    const input = await select(); let clock: ReturnType<typeof vi.spyOn> | undefined;
    vi.mocked(repo.lock).mockImplementation(async () => { clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 901000); });
    try { await expect(service.apply(id, input, context)).rejects.toMatchObject({ code: 'INVALID_GEO_CANDIDATE' }); }
    finally { clock?.mockRestore(); }
    expect(repo.apply).not.toHaveBeenCalled();
  });
  it('rejects missing/deleted villages before lookup or apply', async () => {
    const input = await select(); stored = null;
    await expect(service.candidates(id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.apply(id, input, context)).rejects.toMatchObject({ statusCode: 404 });
    expect(repo.apply).not.toHaveBeenCalled();
  });
  it('rechecks deletion and identity changes during external lookup', async () => {
    provider.lookup.mockImplementationOnce(async () => { stored!.version++; return [candidate]; });
    await expect(service.candidates(id)).rejects.toMatchObject({ statusCode: 409 });
    provider.lookup.mockImplementationOnce(async () => { stored = null; return [candidate]; });
    await expect(service.candidates(id)).rejects.toMatchObject({ statusCode: 404 });
  });
  it('rechecks deletion after acquiring the write lock', async () => {
    const input = await select(); vi.mocked(repo.lock).mockImplementation(async () => { stored = null; });
    await expect(service.apply(id, input, context)).rejects.toMatchObject({ statusCode: 404 }); expect(repo.apply).not.toHaveBeenCalled();
  });
  it('handles optimistic update conflict without audit', async () => {
    const input = await select(); vi.mocked(repo.apply).mockResolvedValue(null);
    await expect(service.apply(id, input, context)).rejects.toMatchObject({ statusCode: 409 }); expect(audit).not.toHaveBeenCalled();
  });
  it('identity normalization includes governorate and country', () => {
    expect(geoIdentity({ nameAr: 'بتير', nameEn: null, governorate: stored!.governorate, countryCode: 'ps' })).toHaveLength(64);
  });
});
