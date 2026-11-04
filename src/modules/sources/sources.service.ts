import { NotFoundError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination, type PaginationMeta } from '../../shared/pagination.js';
import { sourceRepository, type SourceDetails, type SourceRepository, type SourceCreateContext } from './sources.repository.js';
import type { CreateSourceInput, ListSourcesQuery } from './sources.schemas.js';

export interface SourceListResult {
  items: SourceDetails[];
  meta: PaginationMeta;
}

export class SourceService {
  constructor(private readonly repository: SourceRepository = sourceRepository) {}

  create(input: CreateSourceInput, context: SourceCreateContext): Promise<SourceDetails> {
    return this.repository.create(input, context);
  }

  async list(query: ListSourcesQuery): Promise<SourceListResult> {
    const pagination = parsePagination(query);
    const result = await this.repository.findMany({
      filters: { sourceType: query.sourceType, verificationStatus: query.verificationStatus },
      skip: pagination.skip,
      take: pagination.take,
    });
    return { items: result.items, meta: buildPaginationMeta(result.total, pagination) };
  }

  async getById(id: string): Promise<SourceDetails> {
    const source = await this.repository.findById(id);
    if (!source) throw new NotFoundError('Source not found');
    return source;
  }
}

export const sourceService = new SourceService();
