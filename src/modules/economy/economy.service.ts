import { NotFoundError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination, type PaginationMeta } from '../../shared/pagination.js';
import { economyRepository, type EconomyDetails, type EconomyRepository } from './economy.repository.js';
import type { ListEconomyQuery } from './economy.schemas.js';

export interface EconomyListResult {
  items: EconomyDetails[];
  meta: PaginationMeta;
}

export class EconomyService {
  constructor(private readonly repository: EconomyRepository = economyRepository) {}

  async list(villageId: string, query: ListEconomyQuery): Promise<EconomyListResult> {
    const pagination = parsePagination(query);
    const result = await this.repository.findMany({
      villageId,
      filters: {
        search: query.search,
        category: query.category,
        verificationStatus: query.verificationStatus,
        isMajor: query.isMajor,
        asOfYear: query.asOfYear,
      },
      sort: { field: query.sort ?? 'name', order: query.order ?? 'asc' },
      skip: pagination.skip,
      take: pagination.take,
    });
    if (!result) throw new NotFoundError('Village not found');
    return { items: result.items, meta: buildPaginationMeta(result.total, pagination) };
  }

  async getById(id: string): Promise<EconomyDetails> {
    const item = await this.repository.findById(id);
    if (!item) throw new NotFoundError('Economic activity not found');
    return item;
  }
}

export const economyService = new EconomyService();
