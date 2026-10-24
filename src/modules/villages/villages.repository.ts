import type {
  Governorate,
  LocalAuthority,
  Prisma,
  Source,
  VerificationStatus,
  Village,
  VillageName,
} from '@prisma/client';
import { prisma } from '../../shared/db.js';
import type { SortOrder, VillageSortField } from './villages.schemas.js';

export type VillageListItem = Pick<Village, 'id' | 'slug' | 'nameAr' | 'nameEn' | 'verificationStatus'> & {
  governorate: Pick<Governorate, 'id' | 'nameAr' | 'nameEn'>;
  localAuthority: Pick<LocalAuthority, 'id' | 'nameAr'> | null;
  latitude: number | null;
  longitude: number | null;
};

export type VillageAlternateName = Pick<
  VillageName,
  'id' | 'name' | 'language' | 'nameType' | 'periodFrom' | 'periodTo'
> & {
  source: Pick<Source, 'id' | 'title'> | null;
};

export type VillageDetails = Pick<
  Village,
  | 'id'
  | 'slug'
  | 'pcbsCode'
  | 'nameAr'
  | 'nameEn'
  | 'nameOrigin'
  | 'elevationM'
  | 'locationDescription'
  | 'historicalOverview'
  | 'geoDisplayName'
  | 'geoEnrichedAt'
  | 'verificationStatus'
  | 'version'
  | 'createdAt'
  | 'updatedAt'
> & {
  latitude: number | null;
  longitude: number | null;
  areaDunums: number | null;
  governorate: Pick<Governorate, 'id' | 'nameAr' | 'nameEn' | 'code'>;
  localAuthority: Pick<LocalAuthority, 'id' | 'nameAr' | 'nameEn' | 'type'> | null;
  nameOriginSource: Pick<Source, 'id' | 'title' | 'sourceType' | 'url'> | null;
  names: VillageAlternateName[];
};

export type VillageLookup = { id: string } | { slug: string };

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
  /** Returns null when the village does not exist or is soft-deleted. */
  findDetails(lookup: VillageLookup): Promise<VillageDetails | null>;
  /** True only for a village that exists and is not soft-deleted. */
  exists(id: string): Promise<boolean>;
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

function villageDetailsSelect() {
  return {
    id: true,
    slug: true,
    pcbsCode: true,
    nameAr: true,
    nameEn: true,
    nameOrigin: true,
    latitude: true,
    longitude: true,
    elevationM: true,
    areaDunums: true,
    locationDescription: true,
    historicalOverview: true,
    geoDisplayName: true,
    geoEnrichedAt: true,
    verificationStatus: true,
    version: true,
    createdAt: true,
    updatedAt: true,
    governorate: { select: { id: true, nameAr: true, nameEn: true, code: true } },
    localAuthority: { select: { id: true, nameAr: true, nameEn: true, type: true } },
    nameOriginSource: { select: { id: true, title: true, sourceType: true, url: true, deletedAt: true } },
    names: {
      where: { deletedAt: null },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        language: true,
        nameType: true,
        periodFrom: true,
        periodTo: true,
        source: { select: { id: true, title: true, deletedAt: true } },
      },
    },
  } satisfies Prisma.VillageSelect;
}

function toNumber(value: Prisma.Decimal | null): number | null {
  return value?.toNumber() ?? null;
}

// Sources are soft-deletable too, and a to-one relation can't be filtered inside a select,
// so a deleted source is dropped here and reported as null.
function activeSource<T extends { deletedAt: Date | null }>(source: T | null): Omit<T, 'deletedAt'> | null {
  if (!source || source.deletedAt) return null;

  const { deletedAt: _deletedAt, ...rest } = source;
  return rest;
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
      latitude: toNumber(row.latitude),
      longitude: toNumber(row.longitude),
    }));

    return { items, total };
  },

  async findDetails(lookup) {
    const row = await prisma.village.findFirst({
      where: { ...lookup, deletedAt: null },
      select: villageDetailsSelect(),
    });

    if (!row) return null;

    return {
      ...row,
      latitude: toNumber(row.latitude),
      longitude: toNumber(row.longitude),
      areaDunums: toNumber(row.areaDunums),
      nameOriginSource: activeSource(row.nameOriginSource),
      names: row.names.map((name) => ({ ...name, source: activeSource(name.source) })),
    };
  },

  async exists(id) {
    const row = await prisma.village.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });

    return row !== null;
  },
};
