import type { HeritageCategory, HeritageItem, Prisma, VerificationStatus } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import type { CreateHeritageInput, UpdateHeritageInput, HeritageSortField, SortOrder } from './heritage.schemas.js';

export interface HeritageCreateContext { actorId: string; requestId: string }
export type HeritageWriteRecord = HeritageDetails & Pick<HeritageItem, 'createdById' | 'updatedById' | 'deletedAt'>;

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
  transaction<T>(fn: (client: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  create(villageId: string, input: CreateHeritageInput, context: HeritageCreateContext, client: Prisma.TransactionClient): Promise<HeritageDetails>;
  findForWrite(id: string, client: Prisma.TransactionClient): Promise<HeritageWriteRecord | null>;
  lock(id: string, client: Prisma.TransactionClient): Promise<void>;
  updateIfVersion(id: string, input: UpdateHeritageInput, actorId: string, client: Prisma.TransactionClient): Promise<number>;
  softDelete(id: string, actorId: string, client: Prisma.TransactionClient): Promise<number>;
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
  transaction(fn) { return prisma.$transaction(fn); },
  create(villageId, input, context, client) {
    return client.heritageItem.create({ data: {
      ...input, villageId, createdById: context.actorId, updatedById: context.actorId,
      verificationStatus: 'PENDING', version: 1,
    }, select: heritageSelect });
  },
  findForWrite(id, client) {
    return client.heritageItem.findFirst({ where: { id, village: { deletedAt: null } },
      select: { ...heritageSelect, createdById: true, updatedById: true, deletedAt: true } });
  },
  async lock(id, client) {
    await client.$queryRaw`SELECT id FROM heritage_items WHERE id = ${id}::uuid FOR UPDATE`;
  },
  async updateIfVersion(id, input, actorId, client) {
    const { version, ...changes } = input;
    const result = await client.heritageItem.updateMany({ where: { ...activeHeritage, id, version },
      data: { ...changes, verificationStatus: 'PENDING', updatedById: actorId, version: { increment: 1 } } });
    return result.count;
  },
  async softDelete(id, actorId, client) {
    const result = await client.heritageItem.updateMany({ where: { ...activeHeritage, id },
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
