import { NotFoundError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination } from '../../shared/pagination.js';
import { villageService } from '../villages/villages.service.js';
import { populationRepository, type PopulationRepository } from './population.repository.js';
import type { ListPopulationQuery } from './population.schemas.js';
export class PopulationService {
 constructor(private readonly repository: PopulationRepository = populationRepository, private readonly villages: Pick<typeof villageService, 'ensureExists'> = villageService) {}
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
