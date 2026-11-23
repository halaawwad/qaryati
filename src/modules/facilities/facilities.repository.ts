import type { Facility, FacilityType, Prisma, VerificationStatus } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import type { CreateFacilityInput, FacilitySortField, SortOrder } from './facilities.schemas.js';

export interface FacilityCreateContext {
  actorId: string;
  requestId: string;
}

export type FacilitiesDetails = Pick<
  Facility,
  'id' | 'villageId' | 'facilityType' | 'name' | 'description' | 'sourceId' | 'asOfYear' |
  'verificationStatus' | 'version' | 'createdAt' | 'updatedAt'
> & { latitude: number | null; longitude: number | null };

export interface FacilitiesListParams {
  villageId: string;
  filters: {
    search?: string;
    facilityType?: FacilityType;
    verificationStatus?: VerificationStatus;
    asOfYear?: number;
  };
  sort: { field: FacilitySortField; order: SortOrder };
  skip: number;
  take: number;
}

export interface FacilitiesRepository {
  transaction<T>(fn: (client: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  create(villageId: string, input: CreateFacilityInput, context: FacilityCreateContext, client: Prisma.TransactionClient): Promise<FacilitiesDetails>;
  findMany(params: FacilitiesListParams): Promise<{ items: FacilitiesDetails[]; total: number }>;
  /** Only active facilities belonging to active villages are visible. */
  findById(id: string): Promise<FacilitiesDetails | null>;
}

const facilitySelect = {
  id: true, villageId: true, facilityType: true, name: true, description: true,
  latitude: true, longitude: true, sourceId: true, asOfYear: true,
  verificationStatus: true, version: true, createdAt: true, updatedAt: true,
} satisfies Prisma.FacilitySelect;

type FacilityRow = Prisma.FacilityGetPayload<{ select: typeof facilitySelect }>;

function toFacility(row: FacilityRow): FacilitiesDetails {
  return {
    ...row,
    latitude: row.latitude?.toNumber() ?? null,
    longitude: row.longitude?.toNumber() ?? null,
  };
}

// Source deletion does not hide content; the facility and parent control visibility.
const activeFacility = {
  deletedAt: null,
  village: { deletedAt: null },
} satisfies Prisma.FacilityWhereInput;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function buildWhere({ villageId, filters }: FacilitiesListParams): Prisma.FacilityWhereInput {
  const where: Prisma.FacilityWhereInput = {
    ...activeFacility,
    villageId,
    facilityType: filters.facilityType,
    verificationStatus: filters.verificationStatus,
    asOfYear: filters.asOfYear,
  };
  if (filters.search) {
    const contains = { contains: escapeLikePattern(filters.search), mode: 'insensitive' } satisfies Prisma.StringFilter;
    where.OR = [{ name: contains }, { description: contains }];
  }
  return where;
}

function buildOrderBy({ field, order }: FacilitiesListParams['sort']): Prisma.FacilityOrderByWithRelationInput[] {
  const primary: Prisma.FacilityOrderByWithRelationInput = field === 'asOfYear'
    ? { asOfYear: { sort: order, nulls: 'last' } }
    : { [field]: order };
  return [primary, { id: 'asc' }];
}

export const facilitiesRepository: FacilitiesRepository = {
  transaction(fn) {
    return prisma.$transaction(fn);
  },

  async create(villageId, input, context, client) {
    const row = await client.facility.create({
      data: {
        villageId, name: input.name, facilityType: input.facilityType, sourceId: input.sourceId,
        description: input.description, asOfYear: input.asOfYear,
        latitude: input.latitude, longitude: input.longitude,
        createdById: context.actorId, updatedById: context.actorId,
        // Prisma supplies PENDING and version 1, along with ID and timestamps.
      },
      select: facilitySelect,
    });
    return toFacility(row);
  },

  async findMany(params) {
    return prisma.$transaction(async tx => {
      const where = buildWhere(params);
      const [total, rows] = await Promise.all([
        tx.facility.count({ where }),
        tx.facility.findMany({
          where, orderBy: buildOrderBy(params.sort), skip: params.skip, take: params.take,
          select: facilitySelect,
        }),
      ]);
      return { items: rows.map(toFacility), total };
    });
  },

  async findById(id) {
    const row = await prisma.facility.findFirst({
      where: { ...activeFacility, id }, select: facilitySelect,
    });
    return row ? toFacility(row) : null;
  },
};
