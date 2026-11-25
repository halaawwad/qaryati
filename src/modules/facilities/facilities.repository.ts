import type { Facility, FacilityType, Prisma, VerificationStatus } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import type { CreateFacilityInput, UpdateFacilityInput, FacilitySortField, SortOrder } from './facilities.schemas.js';

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
  findForWrite(id: string, client: Prisma.TransactionClient): Promise<FacilityWriteRecord | null>;
  lock(id: string, client: Prisma.TransactionClient): Promise<void>;
  updateIfVersion(id: string, input: UpdateFacilityInput, actorId: string, client: Prisma.TransactionClient): Promise<number>;
  softDelete(id: string, actorId: string, client: Prisma.TransactionClient): Promise<number>;
  transaction<T>(fn: (client: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  create(villageId: string, input: CreateFacilityInput, context: FacilityCreateContext, client: Prisma.TransactionClient): Promise<FacilitiesDetails>;
  findMany(params: FacilitiesListParams): Promise<{ items: FacilitiesDetails[]; total: number }>;
  /** Only active facilities belonging to active villages are visible. */
  findById(id: string): Promise<FacilitiesDetails | null>;
}

export type FacilityWriteRecord = FacilitiesDetails & Pick<Facility, 'createdById' | 'updatedById' | 'deletedAt'>;

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
  async findForWrite(id, client) {
    const row = await client.facility.findFirst({ where: { id, village: { deletedAt: null } },
      select: { ...facilitySelect, createdById: true, updatedById: true, deletedAt: true } });
    return row ? { ...toFacility(row), createdById: row.createdById, updatedById: row.updatedById, deletedAt: row.deletedAt } : null;
  },
  async lock(id, client) {
    await client.$queryRaw`SELECT id FROM facilities WHERE id = ${id}::uuid FOR UPDATE`;
  },
  async updateIfVersion(id, input, actorId, client) {
    const { version, ...changes } = input;
    const result = await client.facility.updateMany({ where: { ...activeFacility, id, version },
      data: { ...changes, verificationStatus: 'PENDING', updatedById: actorId, version: { increment: 1 } } });
    return result.count;
  },
  async softDelete(id, actorId, client) {
    const result = await client.facility.updateMany({ where: { ...activeFacility, id },
      data: { deletedAt: new Date(), updatedById: actorId } });
    return result.count;
  },
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
