import { NotFoundError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination, type PaginationMeta } from '../../shared/pagination.js';
import { heritageRepository, type HeritageDetails, type HeritageRepository } from './heritage.repository.js';
import type { ListHeritageQuery } from './heritage.schemas.js';

export interface HeritageListResult {
  items: HeritageDetails[];
  meta: PaginationMeta;
}

export class HeritageService {
  constructor(private readonly repository: HeritageRepository = heritageRepository) {}

  async list(villageId: string, query: ListHeritageQuery): Promise<HeritageListResult> {
    const pagination = parsePagination(query);
    const result = await this.repository.findMany({
      villageId,
      filters: {
        search: query.search,
        category: query.category,
        verificationStatus: query.verificationStatus,
      },
      sort: { field: query.sort ?? 'name', order: query.order ?? 'asc' },
      skip: pagination.skip,
      take: pagination.take,
    });
    if (!result) throw new NotFoundError('Village not found');
    return { items: result.items, meta: buildPaginationMeta(result.total, pagination) };
  }

  async getById(id: string): Promise<HeritageDetails> {
    const item = await this.repository.findById(id);
    if (!item) throw new NotFoundError('Heritage item not found');
    return item;
  }
}

export const heritageService = new HeritageService();
