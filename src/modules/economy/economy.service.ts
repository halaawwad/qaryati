import { AuditAction, type Role } from '@prisma/client';
import { AppError, ForbiddenError, NotFoundError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination, type PaginationMeta } from '../../shared/pagination.js';
import { recordAudit } from '../audit/audit.service.js';
import { sourceService } from '../sources/sources.service.js';
import { villageService } from '../villages/villages.service.js';
import { economyRepository, type EconomyCreateContext, type EconomyDetails, type EconomyRepository } from './economy.repository.js';
import type { CreateEconomyInput, UpdateEconomyInput, ListEconomyQuery } from './economy.schemas.js';

export interface EconomyWriteContext extends EconomyCreateContext { role: Role }
const versionConflict = (version: number) => new AppError(409, 'VERSION_CONFLICT', 'The economic activity was changed by someone else; reload it and retry', [
  { field: 'version', message: `Current version is ${version}` },
]);
function snapshot(item: EconomyDetails) {
  return { id: item.id, villageId: item.villageId, name: item.name, category: item.category,
    description: item.description, isMajor: item.isMajor, asOfYear: item.asOfYear, sourceId: item.sourceId,
    verificationStatus: item.verificationStatus, version: item.version,
    createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() };
}

export interface EconomyListResult {
  items: EconomyDetails[];
  meta: PaginationMeta;
}

export class EconomyService {
  constructor(private readonly repository: EconomyRepository = economyRepository) {}

  async update(id: string, input: UpdateEconomyInput, context: EconomyWriteContext): Promise<EconomyDetails> {
    return this.repository.transaction(async client => {
      const before = await this.repository.findForWrite(id, client);
      if (!before || before.deletedAt) throw new NotFoundError('Economic activity not found');
      // Match the established existence -> authorization -> version check order.
      if (context.role === 'EDITOR') {
        if (before.verificationStatus !== 'PENDING') throw new AppError(403, 'CHANGE_REQUEST_REQUIRED', 'Reviewed economic activities cannot be edited directly by editors');
        if (before.createdById !== context.actorId) throw new AppError(403, 'ECONOMY_EDIT_FORBIDDEN', 'You can only edit economic activities that you created');
      } else if (context.role !== 'REVIEWER' && context.role !== 'ADMIN') throw new ForbiddenError();
      if (before.version !== input.version) throw versionConflict(before.version);
      await villageService.ensureExists(before.villageId, client);
      if (input.sourceId !== undefined && input.sourceId !== before.sourceId) await sourceService.getById(input.sourceId, client);
      if (!await this.repository.updateIfVersion(id, input, context.actorId, client)) {
        const current = await this.repository.findForWrite(id, client);
        if (!current || current.deletedAt) throw new NotFoundError('Economic activity not found');
        throw versionConflict(current.version);
      }
      const after = await this.repository.findForWrite(id, client);
      if (!after) throw new NotFoundError('Economic activity not found');
      await recordAudit({ entityType: 'EconomicActivity', entityId: id, action: AuditAction.UPDATE,
        actorId: context.actorId, requestId: context.requestId, before: snapshot(before), after: snapshot(after) }, client);
      const { createdById: _creator, updatedById: _updater, deletedAt: _deleted, ...result } = after;
      return result;
    });
  }

  async remove(id: string, context: EconomyWriteContext): Promise<void> {
    if (context.role !== 'ADMIN') throw new ForbiddenError();
    await this.repository.transaction(async client => {
      const initial = await this.repository.findForWrite(id, client);
      if (!initial || initial.deletedAt) throw new NotFoundError('Economic activity not found');
      await villageService.ensureExists(initial.villageId, client);
      // Take the audit snapshot after any concurrent edit finishes; keep lock order village -> activity.
      await this.repository.lock(id, client);
      const before = await this.repository.findForWrite(id, client);
      if (!before || before.deletedAt || !await this.repository.softDelete(id, context.actorId, client)) throw new NotFoundError('Economic activity not found');
      const after = await this.repository.findForWrite(id, client);
      if (!after) throw new NotFoundError('Economic activity not found');
      await recordAudit({ entityType: 'EconomicActivity', entityId: id, action: AuditAction.DELETE,
        actorId: context.actorId, requestId: context.requestId,
        before: { ...snapshot(before), deletedAt: null },
        after: { ...snapshot(after), deletedAt: after.deletedAt!.toISOString() } }, client);
    });
  }

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
