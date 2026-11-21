import type { Prisma } from '@prisma/client';
import { NotFoundError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination, type PaginationMeta } from '../../shared/pagination.js';
import {
  villageRepository,
  type VillageDetails,
  type VillageListItem,
  type VillageRepository,
} from './villages.repository.js';
import type { ListVillagesQuery } from './villages.schemas.js';

export interface VillageListResult {
  items: VillageListItem[];
  meta: PaginationMeta;
}

const DEFAULT_SORT = 'nameAr';
const DEFAULT_ORDER = 'asc';

// Any UUID shape Postgres accepts; anything else is treated as a slug and never reaches a uuid column.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  async getByIdOrSlug(idOrSlug: string): Promise<VillageDetails> {
    const lookup = UUID_PATTERN.test(idOrSlug) ? { id: idOrSlug } : { slug: idOrSlug };
    const village = await this.repository.findDetails(lookup);
    if (!village) {
      throw new NotFoundError('Village not found');
    }

    return village;
  }

  /**
   * Throws NotFoundError (404) unless the village exists and is not soft-deleted.
   *
   * Call this before creating or changing rows that belong to a village (population records,
   * landmarks, heritage items, ...), so that a missing or deleted village returns 404 instead of
   * a foreign-key error or a row attached to a hidden village. Ids that are not UUIDs are
   * rejected without querying the database.
   *
   * With a transaction client, holds a shared row lock until that transaction ends so that
   * deletion or modification cannot race a dependent write. Without one this is only a check.
   */
  async ensureExists(villageId: string, client?: Prisma.TransactionClient): Promise<void> {
    if (!UUID_PATTERN.test(villageId) || !(await this.repository.exists(villageId, client))) {
      throw new NotFoundError('Village not found');
    }
  }
}

export const villageService = new VillageService();
