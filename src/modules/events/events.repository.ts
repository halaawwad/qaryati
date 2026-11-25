import type { HistoricalEvent, Prisma, VerificationStatus } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import type { CreateEventInput, UpdateEventInput, EventSortField, SortOrder } from './events.schemas.js';

export interface EventCreateContext { actorId: string; requestId: string }
export type EventWriteRecord = EventDetails & Pick<HistoricalEvent, 'createdById' | 'updatedById' | 'deletedAt'>;

export type EventDetails = Pick<
  HistoricalEvent,
  'id' | 'villageId' | 'title' | 'description' | 'eventYear' | 'eventDate' |
  'isApproximate' | 'category' | 'sourceId' | 'verificationStatus' | 'version' | 'createdAt' | 'updatedAt'
>;

export interface EventListParams {
  villageId: string;
  filters: {
    search?: string;
    category?: string;
    verificationStatus?: VerificationStatus;
    isApproximate?: boolean;
    yearFrom?: number;
    yearTo?: number;
  };
  sort: { field: EventSortField; order: SortOrder };
  skip: number;
  take: number;
}

export interface EventRepository {
  transaction<T>(fn: (client: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  create(villageId: string, input: CreateEventInput, context: EventCreateContext, client: Prisma.TransactionClient): Promise<EventDetails>;
  findForWrite(id: string, client: Prisma.TransactionClient): Promise<EventWriteRecord | null>;
  lock(id: string, client: Prisma.TransactionClient): Promise<void>;
  updateIfVersion(id: string, input: UpdateEventInput, actorId: string, client: Prisma.TransactionClient): Promise<number>;
  softDelete(id: string, actorId: string, client: Prisma.TransactionClient): Promise<number>;
  /** Null means the parent is missing/deleted; an empty list means no matching events. */
  findMany(params: EventListParams): Promise<{ items: EventDetails[]; total: number } | null>;
  /** Only active events belonging to active villages are visible. */
  findById(id: string): Promise<EventDetails | null>;
}

const eventSelect = {
  id: true,
  villageId: true,
  title: true,
  description: true,
  eventYear: true,
  eventDate: true,
  isApproximate: true,
  category: true,
  sourceId: true,
  verificationStatus: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.HistoricalEventSelect;

// Source deletion does not hide an event; only the event and parent control visibility.
const activeEvent = {
  deletedAt: null,
  village: { deletedAt: null },
} satisfies Prisma.HistoricalEventWhereInput;

// PostgreSQL uses ILIKE for Prisma's insensitive contains and equals filters.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function buildWhere({ villageId, filters }: EventListParams): Prisma.HistoricalEventWhereInput {
  const where: Prisma.HistoricalEventWhereInput = {
    ...activeEvent,
    villageId,
    verificationStatus: filters.verificationStatus,
    isApproximate: filters.isApproximate,
  };

  if (filters.search) {
    const contains = { contains: escapeLikePattern(filters.search), mode: 'insensitive' } satisfies Prisma.StringFilter;
    where.OR = [{ title: contains }, { description: contains }];
  }
  if (filters.category !== undefined) {
    where.category = { equals: escapeLikePattern(filters.category), mode: 'insensitive' };
  }
  if (filters.yearFrom !== undefined || filters.yearTo !== undefined) {
    // Direct eventYear bounds: do not infer a year from eventDate or include null years.
    where.eventYear = { gte: filters.yearFrom, lte: filters.yearTo };
  }

  return where;
}

function buildOrderBy({ field, order }: EventListParams['sort']): Prisma.HistoricalEventOrderByWithRelationInput[] {
  const primary: Prisma.HistoricalEventOrderByWithRelationInput = field === 'eventYear' || field === 'eventDate'
    ? { [field]: { sort: order, nulls: 'last' } }
    : { [field]: order };

  return [primary, { id: 'asc' }];
}

export const eventRepository: EventRepository = {
  transaction(fn) { return prisma.$transaction(fn); },
  create(villageId, input, context, client) {
    return client.historicalEvent.create({ data: {
      ...input, villageId, createdById: context.actorId, updatedById: context.actorId,
      verificationStatus: 'PENDING', version: 1,
    }, select: eventSelect });
  },
  findForWrite(id, client) {
    return client.historicalEvent.findFirst({ where: { id, village: { deletedAt: null } },
      select: { ...eventSelect, createdById: true, updatedById: true, deletedAt: true } });
  },
  async lock(id, client) {
    await client.$queryRaw`SELECT id FROM historical_events WHERE id = ${id}::uuid FOR UPDATE`;
  },
  async updateIfVersion(id, input, actorId, client) {
    const { version, ...changes } = input;
    const result = await client.historicalEvent.updateMany({ where: { ...activeEvent, id, version },
      data: { ...changes, verificationStatus: 'PENDING', updatedById: actorId, version: { increment: 1 } } });
    return result.count;
  },
  async softDelete(id, actorId, client) {
    const result = await client.historicalEvent.updateMany({ where: { ...activeEvent, id },
      data: { deletedAt: new Date(), updatedById: actorId } });
    return result.count;
  },
  async findMany(params) {
    return prisma.$transaction(async (tx) => {
      const village = await tx.village.findFirst({
        where: { id: params.villageId, deletedAt: null },
        select: { id: true },
      });
      if (!village) return null;

      const where = buildWhere(params);
      const [total, items] = await Promise.all([
        tx.historicalEvent.count({ where }),
        tx.historicalEvent.findMany({
          where,
          orderBy: buildOrderBy(params.sort),
          skip: params.skip,
          take: params.take,
          select: eventSelect,
        }),
      ]);

      return { items, total };
    });
  },

  findById(id) {
    return prisma.historicalEvent.findFirst({
      where: { ...activeEvent, id },
      select: eventSelect,
    });
  },
};
