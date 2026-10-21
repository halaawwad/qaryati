import type { Governorate, LocalAuthority, Prisma, VerificationStatus, Village } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import type { SortOrder, VillageSortField } from './villages.schemas.js';

export type VillageListItem = Pick<Village, 'id' | 'slug' | 'nameAr' | 'nameEn' | 'verificationStatus'> & {
  governorate: Pick<Governorate, 'id' | 'nameAr' | 'nameEn'>;
  localAuthority: Pick<LocalAuthority, 'id' | 'nameAr'> | null;
  latitude: number | null;
  longitude: number | null;
};

export interface VillageFilters {
  search?: string;
  governorateId?: string;
  localAuthorityId?: string;
  verificationStatus?: VerificationStatus;
}

export interface VillageListParams {
  filters: VillageFilters;
  sort: { field: VillageSortField; order: SortOrder };
  skip: number;
  take: number;
}

export interface VillageRepository {
  findMany(params: VillageListParams): Promise<{ items: VillageListItem[]; total: number }>;
}

// Only nullable columns accept a `nulls` position in Prisma's orderBy.
const NULLABLE_SORT_FIELDS = new Set<VillageSortField>(['nameEn', 'elevationM', 'areaDunums']);

function villageListSelect() {
  return {
    id: true,
    slug: true,
    nameAr: true,
    nameEn: true,
    latitude: true,
    longitude: true,
    verificationStatus: true,
    governorate: { select: { id: true, nameAr: true, nameEn: true } },
    localAuthority: { select: { id: true, nameAr: true } },
  } satisfies Prisma.VillageSelect;
}

function buildWhere({ search, governorateId, localAuthorityId, verificationStatus }: VillageFilters): Prisma.VillageWhereInput {
  const where: Prisma.VillageWhereInput = {
    deletedAt: null,
    governorateId,
    localAuthorityId,
    verificationStatus,
  };

  if (search) {
    const contains = { contains: search, mode: 'insensitive' } satisfies Prisma.StringFilter;
    where.OR = [
      { nameAr: contains },
      { nameEn: contains },
      { slug: contains },
      { names: { some: { deletedAt: null, name: contains } } },
    ];
  }

  return where;
}

function buildOrderBy({ field, order }: VillageListParams['sort']): Prisma.VillageOrderByWithRelationInput[] {
  const primary = NULLABLE_SORT_FIELDS.has(field)
    ? { [field]: { sort: order, nulls: 'last' } }
    : { [field]: order };

  // id keeps the order stable across pages when the sort column has ties.
  return [primary, { id: 'asc' }];
}

export const villageRepository: VillageRepository = {
  async findMany(params) {
    const where = buildWhere(params.filters);

    const [total, rows] = await prisma.$transaction([
      prisma.village.count({ where }),
      prisma.village.findMany({
        where,
        orderBy: buildOrderBy(params.sort),
        skip: params.skip,
        take: params.take,
        select: villageListSelect(),
      }),
    ]);

    const items = rows.map((row) => ({
      ...row,
      latitude: row.latitude?.toNumber() ?? null,
      longitude: row.longitude?.toNumber() ?? null,
    }));

    return { items, total };
  },
};
