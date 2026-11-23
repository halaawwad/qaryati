import { AuditAction } from '@prisma/client';
import { NotFoundError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination, type PaginationMeta } from '../../shared/pagination.js';
import { sourceService } from '../sources/sources.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { villageService } from '../villages/villages.service.js';
import { landmarkRepository, type LandmarkCreateContext, type LandmarkDetails, type LandmarkRepository } from './landmarks.repository.js';
import type { CreateLandmarkInput, ListLandmarksQuery } from './landmarks.schemas.js';

export interface LandmarkListResult {
  items: LandmarkDetails[];
  meta: PaginationMeta;
}

export class LandmarkService {
  constructor(private readonly repository: LandmarkRepository = landmarkRepository) {}

  async create(villageId: string, input: CreateLandmarkInput, context: LandmarkCreateContext): Promise<LandmarkDetails> {
    await villageService.ensureExists(villageId);
    // Sources owns reference visibility: any active source is usable, regardless of status.
    await sourceService.getById(input.sourceId);
    return this.repository.transaction(async (client) => {
      // Recheck and lock in a fixed order. Early checks alone cannot protect against deletion.
      await villageService.ensureExists(villageId, client);
      await sourceService.getById(input.sourceId, client);
      const landmark = await this.repository.create(villageId, input, context, client);
      await recordAudit({
        entityType: 'Landmark', entityId: landmark.id, action: AuditAction.CREATE,
        actorId: context.actorId, requestId: context.requestId,
        after: {
          id: landmark.id, villageId: landmark.villageId,
          nameAr: landmark.nameAr, nameEn: landmark.nameEn,
          landmarkType: landmark.landmarkType, description: landmark.description,
          latitude: landmark.latitude, longitude: landmark.longitude, sourceId: landmark.sourceId,
          verificationStatus: landmark.verificationStatus, version: landmark.version,
        },
      }, client);
      return landmark;
    });
  }

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
