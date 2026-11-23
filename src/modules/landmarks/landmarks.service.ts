import { NotFoundError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination, type PaginationMeta } from '../../shared/pagination.js';
import { landmarkRepository, type LandmarkDetails, type LandmarkRepository } from './landmarks.repository.js';
import type { ListLandmarksQuery } from './landmarks.schemas.js';

export interface LandmarkListResult {
  items: LandmarkDetails[];
  meta: PaginationMeta;
}

export class LandmarkService {
  constructor(private readonly repository: LandmarkRepository = landmarkRepository) {}

  async list(villageId: string, query: ListLandmarksQuery): Promise<LandmarkListResult> {
    const pagination = parsePagination(query);
    const result = await this.repository.findMany({
      villageId,
      filters: {
        search: query.search,
        landmarkType: query.landmarkType,
        verificationStatus: query.verificationStatus,
      },
      sort: { field: query.sort ?? 'nameAr', order: query.order ?? 'asc' },
      skip: pagination.skip,
      take: pagination.take,
    });

    if (!result) throw new NotFoundError('Village not found');

    return { items: result.items, meta: buildPaginationMeta(result.total, pagination) };
  }

  async getById(id: string): Promise<LandmarkDetails> {
    const landmark = await this.repository.findById(id);
    if (!landmark) throw new NotFoundError('Landmark not found');

    return landmark;
  }
}

export const landmarkService = new LandmarkService();
