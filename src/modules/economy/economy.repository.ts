import type { EconomicCategory, EconomicActivity, Prisma, VerificationStatus } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import type { CreateEconomyInput, EconomySortField, SortOrder } from './economy.schemas.js';

export interface EconomyCreateContext {
  actorId: string;
  requestId: string;
}

export type EconomyDetails = Pick<
  EconomicActivity,
  'id' | 'villageId' | 'category' | 'name' | 'description' | 'isMajor' | 'sourceId' | 'asOfYear' |
  'verificationStatus' | 'version' | 'createdAt' | 'updatedAt'
>;

export interface EconomyListParams {
  villageId: string;
  filters: {
    search?: string;
    category?: EconomicCategory;
    verificationStatus?: VerificationStatus;
    isMajor?: boolean;
    asOfYear?: number;
  };
  sort: { field: EconomySortField; order: SortOrder };
  skip: number;
  take: number;
}

export interface EconomyRepository {
  transaction<T>(fn: (client: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  create(villageId: string, input: CreateEconomyInput, context: EconomyCreateContext, client: Prisma.TransactionClient): Promise<EconomyDetails>;
  /** Null means the parent is missing/deleted; an empty list means no matching items. */
  findMany(params: EconomyListParams): Promise<{ items: EconomyDetails[]; total: number } | null>;
  /** Only active items belonging to active villages are visible. */
  findById(id: string): Promise<EconomyDetails | null>;
}

const economySelect = {
  id: true,
  villageId: true,
  category: true,
  name: true,
  description: true,
  isMajor: true,
  sourceId: true,
  asOfYear: true,
  verificationStatus: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.EconomicActivitySelect;

// Source deletion does not hide content; the item and parent control visibility.
const activeEconomy = {
  deletedAt: null,
  village: { deletedAt: null },
} satisfies Prisma.EconomicActivityWhereInput;

// Treat PostgreSQL ILIKE pattern characters as literal search text.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function buildWhere({ villageId, filters }: EconomyListParams): Prisma.EconomicActivityWhereInput {
  const where: Prisma.EconomicActivityWhereInput = {
    ...activeEconomy,
    villageId,
    category: filters.category,
    verificationStatus: filters.verificationStatus,
    isMajor: filters.isMajor,
    asOfYear: filters.asOfYear,
  };
  if (filters.search) {
    const contains = { contains: escapeLikePattern(filters.search), mode: 'insensitive' } satisfies Prisma.StringFilter;
    where.OR = [{ name: contains }, { description: contains }];
  }
  return where;
}

function buildOrderBy({ field, order }: EconomyListParams['sort']): Prisma.EconomicActivityOrderByWithRelationInput[] {
  const primary: Prisma.EconomicActivityOrderByWithRelationInput = field === 'asOfYear'
    ? { asOfYear: { sort: order, nulls: 'last' } }
    : { [field]: order };
  return [primary, { id: 'asc' }];
}

export const economyRepository: EconomyRepository = {
  transaction(fn) {
    return prisma.$transaction(fn);
  },

  create(villageId, input, context, client) {
    return client.economicActivity.create({
      data: {
        villageId, name: input.name, category: input.category, sourceId: input.sourceId,
        description: input.description, isMajor: input.isMajor, asOfYear: input.asOfYear,
        createdById: context.actorId, updatedById: context.actorId,
        // Prisma supplies PENDING and version 1, along with ID and timestamps.
      },
      select: economySelect,
    });
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
        tx.economicActivity.count({ where }),
        tx.economicActivity.findMany({
          where,
          orderBy: buildOrderBy(params.sort),
          skip: params.skip,
          take: params.take,
          select: economySelect,
        }),
      ]);
      return { items, total };
    });
  },

  findById(id) {
    return prisma.economicActivity.findFirst({
      where: { ...activeEconomy, id },
      select: economySelect,
    });
  },
};
