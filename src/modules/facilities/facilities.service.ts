import { AuditAction, type Role } from '@prisma/client';
import { AppError, ForbiddenError, NotFoundError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination, type PaginationMeta } from '../../shared/pagination.js';
import { villageService } from '../villages/villages.service.js';
import { sourceService } from '../sources/sources.service.js';
import { recordAudit } from '../audit/audit.service.js';
import { facilitiesRepository, type FacilityCreateContext, type FacilitiesDetails, type FacilitiesRepository } from './facilities.repository.js';
import type { CreateFacilityInput, UpdateFacilityInput, ListFacilitiesQuery } from './facilities.schemas.js';

export interface FacilityWriteContext extends FacilityCreateContext { role: Role }
const versionConflict = (version: number) => new AppError(409, 'VERSION_CONFLICT',
  'The facility was changed by someone else; reload it and retry',
  [{ field: 'version', message: `Current version is ${version}` }]);
function snapshot(item: FacilitiesDetails) {
  return { id: item.id, villageId: item.villageId, name: item.name, facilityType: item.facilityType,
    description: item.description, sourceId: item.sourceId, asOfYear: item.asOfYear,
    latitude: item.latitude, longitude: item.longitude, verificationStatus: item.verificationStatus,
    version: item.version, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() };
}

export interface FacilitiesListResult {
  items: FacilitiesDetails[];
  meta: PaginationMeta;
}

export class FacilitiesService {
  constructor(
    private readonly repository: FacilitiesRepository = facilitiesRepository,
    private readonly villages: Pick<typeof villageService, 'ensureExists'> = villageService,
  ) {}

  async update(id: string, input: UpdateFacilityInput, context: FacilityWriteContext): Promise<FacilitiesDetails> {
    return this.repository.transaction(async client => {
      const before = await this.repository.findForWrite(id, client);
      if (!before || before.deletedAt) throw new NotFoundError('Facility not found');
      if (context.role === 'EDITOR') {
        if (before.verificationStatus !== 'PENDING') throw new AppError(403, 'CHANGE_REQUEST_REQUIRED', 'Reviewed facilities cannot be edited directly by editors');
        if (before.createdById !== context.actorId) throw new AppError(403, 'FACILITY_EDIT_FORBIDDEN', 'You can only edit facilities that you created');
      } else if (context.role !== 'REVIEWER' && context.role !== 'ADMIN') throw new ForbiddenError();
      if (before.version !== input.version) throw versionConflict(before.version);
      await this.villages.ensureExists(before.villageId, client);
      if (input.sourceId !== undefined && input.sourceId !== before.sourceId) await sourceService.getById(input.sourceId, client);
      if (!await this.repository.updateIfVersion(id, input, context.actorId, client)) {
        const current = await this.repository.findForWrite(id, client);
        if (!current || current.deletedAt) throw new NotFoundError('Facility not found');
        throw versionConflict(current.version);
      }
      const after = await this.repository.findForWrite(id, client);
      if (!after) throw new NotFoundError('Facility not found');
      await recordAudit({ entityType: 'Facility', entityId: id, action: AuditAction.UPDATE,
        actorId: context.actorId, requestId: context.requestId, before: snapshot(before), after: snapshot(after) }, client);
      const { createdById: _creator, updatedById: _updater, deletedAt: _deleted, ...result } = after;
      return result;
    });
  }

  async remove(id: string, context: FacilityWriteContext): Promise<void> {
    if (context.role !== 'ADMIN') throw new ForbiddenError();
    await this.repository.transaction(async client => {
      const initial = await this.repository.findForWrite(id, client);
      if (!initial || initial.deletedAt) throw new NotFoundError('Facility not found');
      await this.villages.ensureExists(initial.villageId, client);
      // Consistent lock order: village first, then facility. Read the audit snapshot after the lock.
      await this.repository.lock(id, client);
      const before = await this.repository.findForWrite(id, client);
      if (!before || before.deletedAt || !await this.repository.softDelete(id, context.actorId, client)) throw new NotFoundError('Facility not found');
      const after = await this.repository.findForWrite(id, client);
      if (!after) throw new NotFoundError('Facility not found');
      await recordAudit({ entityType: 'Facility', entityId: id, action: AuditAction.DELETE,
        actorId: context.actorId, requestId: context.requestId,
        before: { ...snapshot(before), deletedAt: null },
        after: { ...snapshot(after), deletedAt: after.deletedAt!.toISOString() } }, client);
    });
  }

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
