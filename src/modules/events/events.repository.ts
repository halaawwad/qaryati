import type { HistoricalEvent, Prisma, VerificationStatus } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import type { EventSortField, SortOrder } from './events.schemas.js';

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
