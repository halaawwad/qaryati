import { AuditAction } from '@prisma/client';
import { NotFoundError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination, type PaginationMeta } from '../../shared/pagination.js';
import { villageService } from '../villages/villages.service.js';
import { sourceService } from '../sources/sources.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { facilitiesRepository, type FacilityCreateContext, type FacilitiesDetails, type FacilitiesRepository } from './facilities.repository.js';
import type { CreateFacilityInput, ListFacilitiesQuery } from './facilities.schemas.js';

export interface FacilitiesListResult {
  items: FacilitiesDetails[];
  meta: PaginationMeta;
}

export class FacilitiesService {
  constructor(
    private readonly repository: FacilitiesRepository = facilitiesRepository,
    private readonly villages: Pick<typeof villageService, 'ensureExists'> = villageService,
  ) {}

  async create(villageId: string, input: CreateFacilityInput, context: FacilityCreateContext): Promise<FacilitiesDetails> {
    await this.villages.ensureExists(villageId);
    // Sources owns reference visibility: any active source is usable, regardless of status.
    await sourceService.getById(input.sourceId);
    return this.repository.transaction(async client => {
      // Recheck and lock in the same village/source order used by the other create APIs.
      await this.villages.ensureExists(villageId, client);
      await sourceService.getById(input.sourceId, client);
      const item = await this.repository.create(villageId, input, context, client);
      await recordAudit({
        entityType: 'Facility', entityId: item.id, action: AuditAction.CREATE,
        actorId: context.actorId, requestId: context.requestId, before: null,
        // Snapshot persisted values, including coordinates rounded by PostgreSQL.
        after: {
          id: item.id, villageId: item.villageId, name: item.name, facilityType: item.facilityType,
          description: item.description, sourceId: item.sourceId, asOfYear: item.asOfYear,
          latitude: item.latitude, longitude: item.longitude,
          verificationStatus: item.verificationStatus, version: item.version,
        },
      }, client);
      return item;
    });
  }

  async list(villageId: string, query: ListFacilitiesQuery): Promise<FacilitiesListResult> {
    // Cross-module existence checks go through the Villages service.
    await this.villages.ensureExists(villageId);
    const pagination = parsePagination(query);
    const result = await this.repository.findMany({
      villageId,
      filters: {
        search: query.search, facilityType: query.facilityType,
        verificationStatus: query.verificationStatus, asOfYear: query.asOfYear,
      },
      sort: { field: query.sort ?? 'name', order: query.order ?? 'asc' },
      skip: pagination.skip,
      take: pagination.take,
    });
    // A parent deleted after the first check is filtered out by the repository.
    // Distinguish that case from an active village with an empty result page.
    if (result.items.length === 0) await this.villages.ensureExists(villageId);
    return { items: result.items, meta: buildPaginationMeta(result.total, pagination) };
  }

  async getById(id: string): Promise<FacilitiesDetails> {
    const item = await this.repository.findById(id);
    if (!item) throw new NotFoundError('Facility not found');
    return item;
  }
}

export const facilitiesService = new FacilitiesService();
