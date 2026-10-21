import type {
  Governorate,
  LocalAuthority,
  PlaceRelation,
  PlaceType,
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

export type VillageRef = Pick<Village, 'id' | 'slug' | 'nameAr' | 'nameEn'>;

export interface VillageLocation {
  id: string;
  latitude: number | null;
  longitude: number | null;
}

/** A nearby_places row as stored; the service maps it to the requesting village's point of view. */
export interface NearbyPlaceRow {
  villageId: string;
  relatedVillageId: string | null;
  placeName: string;
  placeType: PlaceType;
  relation: PlaceRelation;
  distanceKm: number | null;
  village: VillageRef & { deletedAt: Date | null };
  relatedVillage: (VillageRef & { deletedAt: Date | null }) | null;
}

export type VillageWithinRadius = VillageRef & { distanceKm: number };

export interface RadiusSearch {
  villageId: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
}

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

/** Columns a client may set on create/update. Server-owned columns are added by the service/repository. */
export interface VillageWriteData {
  slug?: string;
  pcbsCode?: string | null;
  nameAr?: string;
  nameEn?: string | null;
  governorateId?: string;
  localAuthorityId?: string | null;
  nameOrigin?: string | null;
  nameOriginSourceId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  elevationM?: number | null;
  areaDunums?: number | null;
  locationDescription?: string | null;
  historicalOverview?: string | null;
}

export type VillageCreateData = VillageWriteData & {
  slug: string;
  nameAr: string;
  governorateId: string;
  createdById: string;
};

export type VillageChanges = VillageWriteData & { verificationStatus: VerificationStatus };

/** Write-side queries, always bound to one transaction. */
export interface VillageWriteRepository {
  /** The full row, including soft-deleted ones; used for checks and as the audit snapshot. */
  findById(id: string): Promise<Village | null>;
  governorateExists(id: string): Promise<boolean>;
  /** The local authority's governorate id, or null when the local authority does not exist. */
  findLocalAuthorityGovernorateId(id: string): Promise<string | null>;
  /** True for a source that exists and is not soft-deleted. */
  sourceExists(id: string): Promise<boolean>;
  create(data: VillageCreateData): Promise<Village>;
  /**
   * Applies the changes only while the row is still at expectedVersion and not deleted, bumping
   * version and setting updatedById. Returns the number of rows changed (0 or 1).
   */
  updateIfVersion(id: string, expectedVersion: number, changes: VillageChanges, updatedById: string): Promise<number>;
  /** Sets deletedAt unless the row is already deleted. Returns the number of rows changed (0 or 1). */
  softDelete(id: string, updatedById: string): Promise<number>;
}

export interface VillageRepository {
  /** Runs fn in one database transaction; tx is passed along so audit rows commit with the change. */
  transaction<T>(fn: (writes: VillageWriteRepository, tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  findMany(params: VillageListParams): Promise<{ items: VillageListItem[]; total: number }>;
  /** Returns null when the village does not exist or is soft-deleted. */
  findDetails(lookup: VillageLookup): Promise<VillageDetails | null>;
  /** True only for a village that exists and is not soft-deleted. */
  exists(id: string): Promise<boolean>;
  /** Returns null when the village does not exist or is soft-deleted. */
  findLocation(lookup: VillageLookup): Promise<VillageLocation | null>;
  /**
   * Rows where the village is on either side of the relation. Rows recorded by a soft-deleted
   * village (reverse direction) are excluded.
   */
  findNearbyPlaceRows(villageId: string): Promise<NearbyPlaceRow[]>;
  /** Active villages with coordinates within radiusKm of the point, nearest first, excluding villageId. */
  findVillagesWithinRadius(search: RadiusSearch): Promise<VillageWithinRadius[]>;
}

const EARTH_RADIUS_KM = 6371;

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

function villageRefSelect() {
  return { id: true, slug: true, nameAr: true, nameEn: true, deletedAt: true } satisfies Prisma.VillageSelect;
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

function buildWriteRepository(tx: Prisma.TransactionClient): VillageWriteRepository {
  return {
    findById(id) {
      return tx.village.findUnique({ where: { id } });
    },

    async governorateExists(id) {
      const row = await tx.governorate.findUnique({ where: { id }, select: { id: true } });
      return row !== null;
    },

    async findLocalAuthorityGovernorateId(id) {
      const row = await tx.localAuthority.findUnique({ where: { id }, select: { governorateId: true } });
      return row?.governorateId ?? null;
    },

    async sourceExists(id) {
      const row = await tx.source.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
      return row !== null;
    },

    create(data) {
      return tx.village.create({ data });
    },

    async updateIfVersion(id, expectedVersion, changes, updatedById) {
      const result = await tx.village.updateMany({
        where: { id, version: expectedVersion, deletedAt: null },
        data: { ...changes, updatedById, version: { increment: 1 } },
      });

      return result.count;
    },

    async softDelete(id, updatedById) {
      const result = await tx.village.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date(), updatedById },
      });

      return result.count;
    },
  };
}

export const villageRepository: VillageRepository = {
  transaction(fn) {
    return prisma.$transaction((tx) => fn(buildWriteRepository(tx), tx));
  },

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

  async findLocation(lookup) {
    const row = await prisma.village.findFirst({
      where: { ...lookup, deletedAt: null },
      select: { id: true, latitude: true, longitude: true },
    });

    if (!row) return null;

    return { id: row.id, latitude: toNumber(row.latitude), longitude: toNumber(row.longitude) };
  },

  async findNearbyPlaceRows(villageId) {
    const rows = await prisma.nearbyPlace.findMany({
      where: {
        OR: [{ villageId }, { relatedVillageId: villageId, village: { deletedAt: null } }],
      },
      orderBy: [{ distanceKm: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      select: {
        villageId: true,
        relatedVillageId: true,
        placeName: true,
        placeType: true,
        relation: true,
        distanceKm: true,
        village: { select: villageRefSelect() },
        relatedVillage: { select: villageRefSelect() },
      },
    });

    return rows.map((row) => ({ ...row, distanceKm: toNumber(row.distanceKm) }));
  },

  // Raw SQL because the distance is computed per row in the database (Haversine), and Prisma's
  // query builder cannot express computed columns or filter/order by them. $queryRaw with a tagged
  // template sends every ${value} as a bind parameter, so nothing is concatenated into the SQL.
  // least(1, ...) guards asin against floating-point results slightly above 1.
  async findVillagesWithinRadius({ villageId, latitude, longitude, radiusKm }) {
    const rows = await prisma.$queryRaw<
      Array<{ id: string; slug: string; name_ar: string; name_en: string | null; distance_km: number }>
    >`
      SELECT id, slug, name_ar, name_en, distance_km
      FROM (
        SELECT
          v.id,
          v.slug,
          v.name_ar,
          v.name_en,
          2 * ${EARTH_RADIUS_KM}::float8 * asin(least(1, sqrt(
            power(sin(radians(v.latitude::float8 - ${latitude}::float8) / 2), 2)
            + cos(radians(${latitude}::float8)) * cos(radians(v.latitude::float8))
              * power(sin(radians(v.longitude::float8 - ${longitude}::float8) / 2), 2)
          ))) AS distance_km
        FROM villages v
        WHERE v.id <> ${villageId}::uuid
          AND v.deleted_at IS NULL
          AND v.latitude IS NOT NULL
          AND v.longitude IS NOT NULL
      ) AS candidates
      WHERE distance_km <= ${radiusKm}::float8
      ORDER BY distance_km ASC, id ASC
    `;

    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      nameAr: row.name_ar,
      nameEn: row.name_en,
      distanceKm: Math.round(row.distance_km * 100) / 100,
    }));
  },
};
