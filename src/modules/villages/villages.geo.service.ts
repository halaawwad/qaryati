import type { Role } from '@prisma/client';
import { AppError, ConflictError, ForbiddenError } from '../../shared/errors.js';
import { getGeoIntegration } from '../../integrations/geo/index.js';
import { GEO_ATTRIBUTION, type GeoLookup, type GeoProvider } from '../../integrations/geo/geo.provider.js';
import { geoIdentity, type GeoCandidateStore } from '../../integrations/geo/geo.store.js';
import { villageService, type VillageService } from './villages.service.js';
import type { VillageDetails } from './villages.repository.js';
import type { ApplyGeoEnrichment } from './villages.schemas.js';

export type VillageGeo = Pick<VillageDetails, 'nameAr' | 'nameEn' | 'governorate' | 'version'>;
export interface GeoVillageService {
  getByIdOrSlug(id: string): Promise<VillageGeo>;
  applyGeoEnrichment: VillageService['applyGeoEnrichment'];
}
const identity = (village: VillageGeo): GeoLookup => ({
  nameAr: village.nameAr, nameEn: village.nameEn, governorate: village.governorate, countryCode: 'ps',
});

export class VillageGeoService {
  constructor(
    private readonly villages: GeoVillageService = villageService,
    private readonly integration: () => { provider: GeoProvider; candidates: GeoCandidateStore } = getGeoIntegration,
  ) {}
  async candidates(id: string) {
    const village = await this.villages.getByIdOrSlug(id);
    const { provider, candidates } = this.integration();
    const lookup = identity(village);
    const matches = await provider.lookup(lookup);
    const current = await this.villages.getByIdOrSlug(id);
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
  async apply(id: string, input: ApplyGeoEnrichment, context: { actorId: string; role: Role; requestId: string }) {
    if (context.role !== 'ADMIN' && context.role !== 'REVIEWER') throw new ForbiddenError();
    const before = await this.villages.getByIdOrSlug(id);
    const { candidates } = this.integration();
    const selection = await candidates.read(input.candidateRef);
    if (!input.confirm || !selection || selection.villageId !== id || selection.candidate.address.country_code?.toLowerCase() !== 'ps') {
      throw new AppError(400, 'INVALID_GEO_CANDIDATE', 'Candidate is invalid or expired; retrieve candidates again');
    }
    if (input.version !== before.version || selection.version !== before.version || selection.identity !== geoIdentity(identity(before))) {
      throw new ConflictError('Village or candidate version has changed; retrieve candidates again');
    }
    const result = await this.villages.applyGeoEnrichment(id, {
      latitude: selection.candidate.latitude, longitude: selection.candidate.longitude,
      geoDisplayName: selection.candidate.displayName,
    }, {
      actor: { id: context.actorId, role: context.role }, requestId: context.requestId,
      expectedVersion: selection.version, overwrite: input.overwriteExisting,
      beforeApply: () => {
        if (selection.expiresAt <= Date.now()) throw new AppError(400, 'INVALID_GEO_CANDIDATE', 'Candidate has expired; retrieve candidates again');
      },
      provenance: {
        provider: selection.candidate.provider, providerReference: selection.candidate.providerReference,
        candidateRef: input.candidateRef, confirmed: input.confirm, overwriteExisting: input.overwriteExisting,
        attribution: GEO_ATTRIBUTION,
      },
    });
    if (result.status === 'skipped') throw new ConflictError('Existing coordinates require explicit overwriteExisting confirmation');
    return { ...result.village, geoEnrichedAt: result.village.geoEnrichedAt?.toISOString() ?? null };
  }
}
export const villageGeoService = new VillageGeoService();
