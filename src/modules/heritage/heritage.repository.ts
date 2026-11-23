import type { HeritageCategory, HeritageItem, Prisma, VerificationStatus } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import type { HeritageSortField, SortOrder } from './heritage.schemas.js';

export type HeritageDetails = Pick<
  HeritageItem,
  'id' | 'villageId' | 'category' | 'name' | 'description' | 'sourceId' |
  'verificationStatus' | 'version' | 'createdAt' | 'updatedAt'
>;

export interface HeritageListParams {
  villageId: string;
  filters: {
    search?: string;
    category?: HeritageCategory;
    verificationStatus?: VerificationStatus;
  };
  sort: { field: HeritageSortField; order: SortOrder };
  skip: number;
  take: number;
}

export interface HeritageRepository {
  /** Null means the parent is missing/deleted; an empty list means no matching items. */
  findMany(params: HeritageListParams): Promise<{ items: HeritageDetails[]; total: number } | null>;
  /** Only active items belonging to active villages are visible. */
  findById(id: string): Promise<HeritageDetails | null>;
}

const heritageSelect = {
  id: true,
  villageId: true,
  category: true,
  name: true,
  description: true,
  sourceId: true,
  verificationStatus: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.HeritageItemSelect;

// Source deletion does not hide content; the item and parent control visibility.
const activeHeritage = {
  deletedAt: null,
  village: { deletedAt: null },
} satisfies Prisma.HeritageItemWhereInput;

// Treat PostgreSQL ILIKE pattern characters as literal search text.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function buildWhere({ villageId, filters }: HeritageListParams): Prisma.HeritageItemWhereInput {
  const where: Prisma.HeritageItemWhereInput = {
    ...activeHeritage,
    villageId,
    category: filters.category,
    verificationStatus: filters.verificationStatus,
  };
  if (filters.search) {
    const contains = { contains: escapeLikePattern(filters.search), mode: 'insensitive' } satisfies Prisma.StringFilter;
    where.OR = [{ name: contains }, { description: contains }];
  }
  return where;
}

export const heritageRepository: HeritageRepository = {
  async findMany(params) {
    return prisma.$transaction(async (tx) => {
      const village = await tx.village.findFirst({
        where: { id: params.villageId, deletedAt: null },
        select: { id: true },
      });
      if (!village) return null;

      const where = buildWhere(params);
      const [total, items] = await Promise.all([
        tx.heritageItem.count({ where }),
        tx.heritageItem.findMany({
          where,
          orderBy: [{ [params.sort.field]: params.sort.order }, { id: 'asc' }],
          skip: params.skip,
          take: params.take,
          select: heritageSelect,
        }),
      ]);
      return { items, total };
    });
  },

  findById(id) {
    return prisma.heritageItem.findFirst({
      where: { ...activeHeritage, id },
      select: heritageSelect,
    });
  },
};
