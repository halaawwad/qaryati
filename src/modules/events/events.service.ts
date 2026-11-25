import { AuditAction, type Role } from '@prisma/client';
import { AppError, ForbiddenError, NotFoundError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination, type PaginationMeta } from '../../shared/pagination.js';
import { eventRepository, type EventCreateContext, type EventDetails, type EventRepository } from './events.repository.js';
import type { CreateEventInput, UpdateEventInput, ListEventsQuery } from './events.schemas.js';
import { villageService } from '../villages/villages.service.js';
import { sourceService } from '../sources/sources.service.js';
import { recordAudit } from '../audit/audit.service.js';

export interface EventWriteContext extends EventCreateContext { role: Role }
const versionConflict = (version: number) => new AppError(409, 'VERSION_CONFLICT',
  'The historical event was changed by someone else; reload it and retry',
  [{ field: 'version', message: `Current version is ${version}` }]);
function snapshot(item: EventDetails) {
  return { id: item.id, villageId: item.villageId, title: item.title, description: item.description,
    eventYear: item.eventYear, eventDate: item.eventDate?.toISOString() ?? null,
    isApproximate: item.isApproximate, category: item.category, sourceId: item.sourceId,
    verificationStatus: item.verificationStatus, version: item.version,
    createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() };
}

export interface EventListResult {
  items: EventDetails[];
  meta: PaginationMeta;
}

export class EventService {
  constructor(private readonly repository: EventRepository = eventRepository) {}

  async create(villageId: string, input: CreateEventInput, context: EventCreateContext): Promise<EventDetails> {
    return this.repository.transaction(async client => {
      await villageService.ensureExists(villageId, client);
      if (input.sourceId) await sourceService.getById(input.sourceId, client);
      const item = await this.repository.create(villageId, input, context, client);
      await recordAudit({ entityType: 'HistoricalEvent', entityId: item.id, action: AuditAction.CREATE,
        actorId: context.actorId, requestId: context.requestId, before: null, after: snapshot(item) }, client);
      return item;
    });
  }

  async update(id: string, input: UpdateEventInput, context: EventWriteContext): Promise<EventDetails> {
    return this.repository.transaction(async client => {
      const before = await this.repository.findForWrite(id, client);
      if (!before || before.deletedAt) throw new NotFoundError('Historical event not found');
      if (context.role === 'EDITOR') {
        if (before.verificationStatus !== 'PENDING') throw new AppError(403, 'CHANGE_REQUEST_REQUIRED', 'Reviewed events cannot be edited directly by editors');
        if (before.createdById !== context.actorId) throw new AppError(403, 'EVENT_EDIT_FORBIDDEN', 'You can only edit events that you created');
      } else if (context.role !== 'REVIEWER' && context.role !== 'ADMIN') throw new ForbiddenError();
      if (before.version !== input.version) throw versionConflict(before.version);
      await villageService.ensureExists(before.villageId, client);
      if (input.sourceId && input.sourceId !== before.sourceId) await sourceService.getById(input.sourceId, client);
      if (!await this.repository.updateIfVersion(id, input, context.actorId, client)) {
        const current = await this.repository.findForWrite(id, client);
        if (!current || current.deletedAt) throw new NotFoundError('Historical event not found');
        throw versionConflict(current.version);
      }
      const after = await this.repository.findForWrite(id, client);
      if (!after) throw new NotFoundError('Historical event not found');
      await recordAudit({ entityType: 'HistoricalEvent', entityId: id, action: AuditAction.UPDATE,
        actorId: context.actorId, requestId: context.requestId, before: snapshot(before), after: snapshot(after) }, client);
      const { createdById: _creator, updatedById: _updater, deletedAt: _deleted, ...result } = after;
      return result;
    });
  }

  async remove(id: string, context: EventWriteContext): Promise<void> {
    if (context.role !== 'ADMIN') throw new ForbiddenError();
    await this.repository.transaction(async client => {
      const initial = await this.repository.findForWrite(id, client);
      if (!initial || initial.deletedAt) throw new NotFoundError('Historical event not found');
      await villageService.ensureExists(initial.villageId, client);
      // Match parent -> child lock order and capture the snapshot after concurrent edits finish.
      await this.repository.lock(id, client);
      const before = await this.repository.findForWrite(id, client);
      if (!before || before.deletedAt || !await this.repository.softDelete(id, context.actorId, client)) throw new NotFoundError('Historical event not found');
      const after = await this.repository.findForWrite(id, client);
      if (!after) throw new NotFoundError('Historical event not found');
      await recordAudit({ entityType: 'HistoricalEvent', entityId: id, action: AuditAction.DELETE,
        actorId: context.actorId, requestId: context.requestId,
        before: { ...snapshot(before), deletedAt: null },
        after: { ...snapshot(after), deletedAt: after.deletedAt!.toISOString() } }, client);
    });
  }

  async list(villageId: string, query: ListEventsQuery): Promise<EventListResult> {
    const pagination = parsePagination(query);
    const result = await this.repository.findMany({
      villageId,
      filters: {
        search: query.search,
        category: query.category,
        verificationStatus: query.verificationStatus,
        isApproximate: query.isApproximate,
        yearFrom: query.yearFrom,
        yearTo: query.yearTo,
      },
      sort: { field: query.sort ?? 'eventYear', order: query.order ?? 'asc' },
      skip: pagination.skip,
      take: pagination.take,
    });

    if (!result) throw new NotFoundError('Village not found');

    return { items: result.items, meta: buildPaginationMeta(result.total, pagination) };
  }

  async getById(id: string): Promise<EventDetails> {
    const event = await this.repository.findById(id);
    if (!event) throw new NotFoundError('Historical event not found');

    return event;
  }
}

export const eventService = new EventService();
