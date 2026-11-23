import { AuditAction } from '@prisma/client';
import { NotFoundError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination, type PaginationMeta } from '../../shared/pagination.js';
import { recordAudit } from '../audit/audit.service.js';
import { sourceService } from '../sources/sources.service.js';
import { villageService } from '../villages/villages.service.js';
import { economyRepository, type EconomyCreateContext, type EconomyDetails, type EconomyRepository } from './economy.repository.js';
import type { CreateEconomyInput, ListEconomyQuery } from './economy.schemas.js';

export interface EconomyListResult {
  items: EconomyDetails[];
  meta: PaginationMeta;
}

export class EconomyService {
  constructor(private readonly repository: EconomyRepository = economyRepository) {}

  async create(villageId: string, input: CreateEconomyInput, context: EconomyCreateContext): Promise<EconomyDetails> {
    await villageService.ensureExists(villageId);
    // Sources owns reference visibility: any active source is usable, regardless of status.
    await sourceService.getById(input.sourceId);
    return this.repository.transaction(async client => {
      // Recheck and lock in the same village/source order used by Landmarks Create.
      await villageService.ensureExists(villageId, client);
      await sourceService.getById(input.sourceId, client);
      const item = await this.repository.create(villageId, input, context, client);
      await recordAudit({
        entityType: 'EconomicActivity', entityId: item.id, action: AuditAction.CREATE,
        actorId: context.actorId, requestId: context.requestId,
        after: {
          id: item.id, villageId: item.villageId, name: item.name, category: item.category,
          description: item.description, isMajor: item.isMajor, asOfYear: item.asOfYear,
          sourceId: item.sourceId, verificationStatus: item.verificationStatus, version: item.version,
        },
      }, client);
      return item;
    });
  }

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
