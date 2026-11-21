import type { Landmark, LandmarkType, Prisma, VerificationStatus } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import type { CreateLandmarkInput, LandmarkSortField, SortOrder } from './landmarks.schemas.js';

export interface LandmarkCreateContext {
  actorId: string;
  requestId: string;
}

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
  transaction<T>(fn: (client: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  create(villageId: string, input: CreateLandmarkInput, context: LandmarkCreateContext, client: Prisma.TransactionClient): Promise<LandmarkDetails>;
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
  transaction(fn) {
    return prisma.$transaction(fn);
  },

  async create(villageId, input, context, client) {
    const row = await client.landmark.create({
      data: {
        villageId, nameAr: input.nameAr, nameEn: input.nameEn,
        landmarkType: input.landmarkType, description: input.description,
        latitude: input.latitude, longitude: input.longitude, sourceId: input.sourceId,
        createdById: context.actorId, updatedById: context.actorId,
        // Prisma supplies PENDING and version 1, along with ID and timestamps.
      },
      select: landmarkSelect,
    });
    return toLandmark(row);
  },

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
