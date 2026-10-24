import type { Landmark, LandmarkType, Prisma, VerificationStatus } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import type { LandmarkSortField, SortOrder } from './landmarks.schemas.js';

export type LandmarkDetails = Pick<
  Landmark,
  'id' | 'villageId' | 'nameAr' | 'nameEn' | 'landmarkType' | 'description' | 'sourceId' |
  'verificationStatus' | 'version' | 'createdAt' | 'updatedAt'
> & {
  latitude: number | null;
  longitude: number | null;
};

export interface LandmarkListParams {
  villageId: string;
  filters: {
    search?: string;
    landmarkType?: LandmarkType;
    verificationStatus?: VerificationStatus;
  };
  sort: { field: LandmarkSortField; order: SortOrder };
  skip: number;
  take: number;
}

export interface LandmarkRepository {
  /** Null means the village is missing or deleted; an empty list means no matching landmarks. */
  findMany(params: LandmarkListParams): Promise<{ items: LandmarkDetails[]; total: number } | null>;
  /** Only returns active landmarks belonging to active villages. */
  findById(id: string): Promise<LandmarkDetails | null>;
}

const landmarkSelect = {
  id: true,
  villageId: true,
  nameAr: true,
  nameEn: true,
  landmarkType: true,
  description: true,
  latitude: true,
  longitude: true,
  sourceId: true,
  verificationStatus: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LandmarkSelect;

type LandmarkRow = Prisma.LandmarkGetPayload<{ select: typeof landmarkSelect }>;

function toLandmark(row: LandmarkRow): LandmarkDetails {
  return {
    ...row,
    latitude: row.latitude?.toNumber() ?? null,
    longitude: row.longitude?.toNumber() ?? null,
  };
}

// Apply the same visibility rule to list rows, counts, and individual records.
const activeLandmark = {
  deletedAt: null,
  village: { deletedAt: null },
} satisfies Prisma.LandmarkWhereInput;

function buildWhere({ villageId, filters }: LandmarkListParams): Prisma.LandmarkWhereInput {
  const where: Prisma.LandmarkWhereInput = {
    ...activeLandmark,
    villageId,
    landmarkType: filters.landmarkType,
    verificationStatus: filters.verificationStatus,
  };

  if (filters.search) {
    const contains = { contains: filters.search, mode: 'insensitive' } satisfies Prisma.StringFilter;
    where.OR = [{ nameAr: contains }, { nameEn: contains }];
  }

  return where;
}

function buildOrderBy({ field, order }: LandmarkListParams['sort']): Prisma.LandmarkOrderByWithRelationInput[] {
  const primary = field === 'nameEn'
    ? { [field]: { sort: order, nulls: 'last' as const } }
    : { [field]: order };

  // The unique tie-breaker keeps pagination stable when names or timestamps match.
  return [primary, { id: 'asc' }];
}

export const landmarkRepository: LandmarkRepository = {
  async findMany(params) {
    return prisma.$transaction(async (tx) => {
      const village = await tx.village.findFirst({
        where: { id: params.villageId, deletedAt: null },
        select: { id: true },
      });
      if (!village) return null;

      const where = buildWhere(params);
      const [total, rows] = await Promise.all([
        tx.landmark.count({ where }),
        tx.landmark.findMany({
          where,
          orderBy: buildOrderBy(params.sort),
          skip: params.skip,
          take: params.take,
          select: landmarkSelect,
        }),
      ]);

      return { items: rows.map(toLandmark), total };
    });
  },

  async findById(id) {
    const row = await prisma.landmark.findFirst({
      where: { ...activeLandmark, id },
      select: landmarkSelect,
    });

    return row ? toLandmark(row) : null;
  },
};
