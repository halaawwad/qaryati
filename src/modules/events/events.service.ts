import { NotFoundError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination, type PaginationMeta } from '../../shared/pagination.js';
import { eventRepository, type EventDetails, type EventRepository } from './events.repository.js';
import type { ListEventsQuery } from './events.schemas.js';

export interface EventListResult {
  items: EventDetails[];
  meta: PaginationMeta;
}

export class EventService {
  constructor(private readonly repository: EventRepository = eventRepository) {}

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
