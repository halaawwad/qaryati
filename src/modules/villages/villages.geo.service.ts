import { AuditAction } from '@prisma/client';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors.js';
import { getGeoIntegration } from '../../integrations/geo/index.js';
import { GEO_ATTRIBUTION, type GeoLookup, type GeoProvider } from '../../integrations/geo/geo.provider.js';
import { geoIdentity, type GeoCandidateStore } from '../../integrations/geo/geo.store.js';
import { recordAudit } from '../audit/audit.service.js';
import { villageGeoRepository, type VillageGeo, type VillageGeoRepository } from './villages.geo.repository.js';
import type { ApplyGeoEnrichment } from './villages.schemas.js';

const identity = (village: VillageGeo): GeoLookup => ({
  nameAr: village.nameAr, nameEn: village.nameEn, governorate: village.governorate, countryCode: 'ps',
});
const snapshot = (village: VillageGeo) => ({
  latitude: village.latitude, longitude: village.longitude, geoDisplayName: village.geoDisplayName,
  geoEnrichedAt: village.geoEnrichedAt?.toISOString() ?? null, version: village.version,
  verificationStatus: village.verificationStatus,
});

export class VillageGeoService {
  constructor(
    private readonly repository: VillageGeoRepository = villageGeoRepository,
    private readonly integration: () => { provider: GeoProvider; candidates: GeoCandidateStore } = getGeoIntegration,
    private readonly audit: typeof recordAudit = recordAudit,
  ) {}
  async candidates(id: string) {
    const village = await this.repository.find(id);
    if (!village) throw new NotFoundError('Village not found');
    const { provider, candidates } = this.integration();
    const lookup = identity(village);
    const matches = await provider.lookup(lookup);
    // A lookup can take seconds: never issue usable references for an obsolete identity.
    const current = await this.repository.find(id);
    if (!current) throw new NotFoundError('Village not found');
    if (current.version !== village.version || geoIdentity(identity(current)) !== geoIdentity(lookup)) {
      throw new ConflictError('Village changed during lookup; retrieve candidates again');
    }
    return {
      villageId: id, version: village.version,
      status: matches.length === 0 ? 'no_match' : matches.length > 1 ? 'ambiguous' : 'candidates_found',
      candidates: await Promise.all(matches.map(candidate => candidates.issue({
        villageId: id, version: village.version, identity: geoIdentity(lookup), candidate,
      }))), attribution: GEO_ATTRIBUTION,
    };
  }
  async apply(id: string, input: ApplyGeoEnrichment, context: { actorId: string; requestId: string }) {
    if (!await this.repository.find(id)) throw new NotFoundError('Village not found');
    const { candidates } = this.integration();
    const selection = await candidates.read(input.candidateRef);
    if (!selection || selection.villageId !== id) {
      throw new AppError(400, 'INVALID_GEO_CANDIDATE', 'Candidate is invalid or expired; retrieve candidates again');
    }
    return this.repository.transaction(async tx => {
      await this.repository.lock(id, tx);
      const before = await this.repository.find(id, tx);
      if (!before) throw new NotFoundError('Village not found');
      if (selection.expiresAt <= Date.now()) throw new AppError(400, 'INVALID_GEO_CANDIDATE', 'Candidate has expired; retrieve candidates again');
      if (input.version !== before.version || selection.version !== before.version || selection.identity !== geoIdentity(identity(before))) {
        throw new ConflictError('Village or candidate version has changed; retrieve candidates again');
      }
      if ((before.latitude !== null || before.longitude !== null) && !input.overwriteExisting) {
        throw new ConflictError('Existing coordinates require explicit overwriteExisting confirmation');
      }
      const after = await this.repository.apply(id, before.version, {
        latitude: selection.candidate.latitude, longitude: selection.candidate.longitude,
        geoDisplayName: selection.candidate.displayName, geoEnrichedAt: new Date(), actorId: context.actorId,
      }, tx);
      if (!after) throw new ConflictError('Village changed; retrieve candidates again');
      await this.audit({
        entityType: 'Village', entityId: id, action: AuditAction.UPDATE, ...context,
        before: snapshot(before), after: { ...snapshot(after), provenance: {
          provider: selection.candidate.provider, providerReference: selection.candidate.providerReference,
          candidateRef: input.candidateRef, confirmed: input.confirm, overwriteExisting: input.overwriteExisting,
          attribution: GEO_ATTRIBUTION,
        } },
      }, tx);
      return { id: after.id, ...snapshot(after), updatedAt: after.updatedAt };
    });
  }
}
export const villageGeoService = new VillageGeoService();
