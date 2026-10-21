import { buildPaginationMeta, parsePagination, type PaginationMeta } from '../../shared/pagination.js';
import { villageRepository, type VillageListItem, type VillageRepository } from './villages.repository.js';
import type { ListVillagesQuery } from './villages.schemas.js';

export interface VillageListResult {
  items: VillageListItem[];
  meta: PaginationMeta;
}

const DEFAULT_SORT = 'nameAr';
const DEFAULT_ORDER = 'asc';

export class VillageService {
  constructor(private readonly repository: VillageRepository = villageRepository) {}

  async list(query: ListVillagesQuery): Promise<VillageListResult> {
    const pagination = parsePagination(query);

    const { items, total } = await this.repository.findMany({
      filters: {
        search: query.search,
        governorateId: query.governorateId,
        localAuthorityId: query.localAuthorityId,
        verificationStatus: query.verificationStatus,
      },
      sort: { field: query.sort ?? DEFAULT_SORT, order: query.order ?? DEFAULT_ORDER },
      skip: pagination.skip,
      take: pagination.take,
    });

    return { items, meta: buildPaginationMeta(total, pagination) };
  }
}

export const villageService = new VillageService();
