import { NotFoundError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination } from '../../shared/pagination.js';
import { villageService } from '../villages/villages.service.js';
import { sourceService } from '../sources/sources.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { populationRepository, type PopulationRepository, type PopulationCreateContext } from './population.repository.js';
import type { CreatePopulationInput, ListPopulationQuery } from './population.schemas.js';
export class PopulationService {
 constructor(private readonly repository: PopulationRepository = populationRepository, private readonly villages: Pick<typeof villageService, 'ensureExists'> = villageService) {}
 async create(villageId: string, input: CreatePopulationInput, context: PopulationCreateContext) {
  await this.villages.ensureExists(villageId);
  await sourceService.getById(input.sourceId);
  return this.repository.transaction(async client => {
   await this.villages.ensureExists(villageId, client);
   await sourceService.getById(input.sourceId, client);
   const baseline = await this.repository.findLatestVerified(villageId, client);
   const needsReview = baseline !== null && (!Number.isSafeInteger(baseline.population) || baseline.population <= 0 || Math.abs(input.population - baseline.population) * 2 > baseline.population);
   const item = await this.repository.create(villageId, input, needsReview, context, client);
   await recordAudit({ entityType: 'PopulationRecord', entityId: item.id, action: 'CREATE', actorId: context.actorId, requestId: context.requestId, before: null,
    after: { id: item.id, villageId: item.villageId, population: item.population, referenceYear: item.referenceYear, referenceDate: item.referenceDate?.toISOString() ?? null, sourceId: item.sourceId, isEstimate: item.isEstimate, isPreferred: item.isPreferred, needsReview: item.needsReview, notes: item.notes, verificationStatus: item.verificationStatus, version: item.version },
   }, client);
   return item;
  });
 }
 async list(villageId: string, query: ListPopulationQuery) {
  await this.villages.ensureExists(villageId);
  const pagination = parsePagination(query);
  const {referenceYear, sourceId, isEstimate, isPreferred, needsReview, verificationStatus} = query;
  const result = await this.repository.findMany({villageId, filters: {referenceYear, sourceId, isEstimate, isPreferred, needsReview, verificationStatus}, sort: {field: query.sort ?? 'referenceYear', order: query.order ?? 'desc'}, skip: pagination.skip, take: pagination.take});
  if (result.items.length === 0) await this.villages.ensureExists(villageId);
  return {items: result.items, meta: buildPaginationMeta(result.total, pagination)};
 }
 async getById(id: string) { const item = await this.repository.findById(id); if (!item) throw new NotFoundError('Population record not found'); return item; }
}
export const populationService = new PopulationService();
