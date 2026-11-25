import { AuditAction, type Role } from '@prisma/client';
import { AppError, ForbiddenError, NotFoundError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination, type PaginationMeta } from '../../shared/pagination.js';
import { sourceService } from '../sources/sources.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { villageService } from '../villages/villages.service.js';
import { landmarkRepository, type LandmarkCreateContext, type LandmarkDetails, type LandmarkRepository } from './landmarks.repository.js';
import type { CreateLandmarkInput, UpdateLandmarkInput, ListLandmarksQuery } from './landmarks.schemas.js';

export interface LandmarkWriteContext extends LandmarkCreateContext { role: Role }
const conflict = (version: number) => new AppError(409, 'VERSION_CONFLICT', 'The landmark was changed by someone else; reload it and retry', [
  { field: 'version', message: `Current version is ${version}` },
]);
// Explicit JSON-safe public content; internal actor fields never enter API responses.
function snapshot(record: LandmarkDetails) {
  return { id: record.id, villageId: record.villageId, nameAr: record.nameAr, nameEn: record.nameEn,
    landmarkType: record.landmarkType, description: record.description, latitude: record.latitude,
    longitude: record.longitude, sourceId: record.sourceId, verificationStatus: record.verificationStatus,
    version: record.version, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString() };
}

export interface LandmarkListResult {
  items: LandmarkDetails[];
  meta: PaginationMeta;
}

export class LandmarkService {
  constructor(private readonly repository: LandmarkRepository = landmarkRepository) {}

  async update(id: string, input: UpdateLandmarkInput, context: LandmarkWriteContext): Promise<LandmarkDetails> {
    return this.repository.transaction(async client => {
      const before = await this.repository.findForWrite(id, client);
      if (!before || before.deletedAt) throw new NotFoundError('Landmark not found');
      if (context.role === 'EDITOR') {
        if (before.verificationStatus !== 'PENDING') throw new AppError(403, 'CHANGE_REQUEST_REQUIRED', 'Reviewed landmarks cannot be edited directly by editors');
        if (before.createdById !== context.actorId) throw new AppError(403, 'LANDMARK_EDIT_FORBIDDEN', 'You can only edit landmarks that you created');
      } else if (context.role !== 'REVIEWER' && context.role !== 'ADMIN') throw new ForbiddenError();
      if (before.version !== input.version) throw conflict(before.version);
      await villageService.ensureExists(before.villageId, client);
      if (input.sourceId !== undefined) await sourceService.getById(input.sourceId, client);
      if (!await this.repository.updateIfVersion(id, input, context.actorId, client)) {
        const current = await this.repository.findForWrite(id, client);
        if (!current || current.deletedAt) throw new NotFoundError('Landmark not found');
        throw conflict(current.version);
      }
      const after = await this.repository.findForWrite(id, client);
      if (!after) throw new NotFoundError('Landmark not found');
      await recordAudit({ entityType: 'Landmark', entityId: id, action: AuditAction.UPDATE,
        actorId: context.actorId, requestId: context.requestId, before: snapshot(before), after: snapshot(after) }, client);
      const { createdById: _creator, updatedById: _updater, deletedAt: _deleted, ...result } = after;
      return result;
    });
  }

  async remove(id: string, context: LandmarkWriteContext): Promise<void> {
    if (context.role !== 'ADMIN') throw new ForbiddenError();
    await this.repository.transaction(async client => {
      const initial = await this.repository.findForWrite(id, client);
      if (!initial || initial.deletedAt) throw new NotFoundError('Landmark not found');
      await villageService.ensureExists(initial.villageId, client);
      // Serialize deletion with edits so the DELETE audit captures the actual prior content.
      await this.repository.lock(id, client);
      const before = await this.repository.findForWrite(id, client);
      if (!before || before.deletedAt || !await this.repository.softDelete(id, context.actorId, client)) throw new NotFoundError('Landmark not found');
      const after = await this.repository.findForWrite(id, client);
      if (!after) throw new NotFoundError('Landmark not found');
      await recordAudit({ entityType: 'Landmark', entityId: id, action: AuditAction.DELETE,
        actorId: context.actorId, requestId: context.requestId,
        before: { ...snapshot(before), deletedAt: null },
        after: { ...snapshot(after), deletedAt: after.deletedAt!.toISOString() } }, client);
    });
  }

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
