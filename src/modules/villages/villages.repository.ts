import type {
  Governorate,
  LocalAuthority,
  PlaceRelation,
  PlaceType,
  Source,
  VerificationStatus,
  Village,
  VillageName,
} from '@prisma/client';
import { Prisma } from '@prisma/client';
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

export interface VillageRepository {
  findMany(params: VillageListParams): Promise<{ items: VillageListItem[]; total: number }>;
  /** Returns null when the village does not exist or is soft-deleted. */
  findDetails(lookup: VillageLookup): Promise<VillageDetails | null>;

  /** True only for an active village; a supplied transaction holds a shared row lock. */
  exists(id: string, client?: Prisma.TransactionClient): Promise<boolean>;

  /** Returns null when the village does not exist or is soft-deleted. */
  findLocation(lookup: VillageLookup): Promise<VillageLocation | null>;

  /**
   * Rows where the village is on either side of the relation.
   * Rows recorded by a soft-deleted village (reverse direction) are excluded.
   */
  findNearbyPlaceRows(villageId: string): Promise<NearbyPlaceRow[]>;

  /** Active villages with coordinates within radiusKm, nearest first, excluding villageId. */
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

// Filters without a search term. A search goes through findIdsBySearch instead (see there for why).
function buildWhere({ governorateId, localAuthorityId, verificationStatus }: VillageFilters): Prisma.VillageWhereInput {
  return {
    deletedAt: null,
    governorateId,
    localAuthorityId,
    verificationStatus,
  };
}

// Whitelisted sort columns for the raw search query (raw SQL can't take a column name as a bound value).
const SORT_COLUMNS: Record<VillageSortField, Prisma.Sql> = {
  nameAr: Prisma.sql`v.name_ar`,
  nameEn: Prisma.sql`v.name_en`,
  createdAt: Prisma.sql`v.created_at`,
  elevationM: Prisma.sql`v.elevation_m`,
  areaDunums: Prisma.sql`v.area_dunums`,
};

/**
 * Escapes the characters that mean something inside a LIKE pattern, so a search term is matched literally.
 * The backslash comes first in the character class on purpose: every `\`, `%` and `_` gets a backslash in front
 * of it in one pass, so the escapes added for `%` and `_` are not escaped again.
 *
 * The queries below do NOT say ESCAPE '\' on purpose. A backslash is already PostgreSQL's default LIKE escape
 * character, so the clause would change nothing about the result, but writing it makes the planner stop using the
 * trigram indexes on villages: it falls back to a sequential scan. On 20,000 villages the count query took
 * 190-270 ms with the clause, against 8-13 ms without it for a selective term and 110-130 ms for a common one
 * (about 1,000 matches), where the plan is a BitmapOr over the indexes. Measured with EXPLAIN ANALYZE, with
 * literal patterns and with a bound parameter. Do not add the clause back without measuring again; see
 * docs/performance.md.
 */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

/**
 * The ids of the villages that match a search term, one page of them, and the total.
 *
 * Why this is raw SQL: Prisma's `OR [nameAr, nameEn, slug, names some]` becomes
 *   name_ar ILIKE .. OR name_en ILIKE .. OR slug ILIKE .. OR id IN (SELECT .. FROM village_names ..)
 * and an OR that contains an IN-subquery cannot use the trigram indexes: Postgres falls back to a sequential
 * scan of villages even when the indexes exist. Splitting it into a UNION lets each side use its own index
 * (a BitmapOr over the three villages indexes, and a Bitmap scan of village_names).
 *
 * The term is matched literally: `\`, `%` and `_` in it are escaped (see escapeLikePattern, which also explains
 * why there is no ESCAPE clause), so searching for `%` finds names that contain a percent sign, not every
 * village, and `bei_` does not match `beit`. The filters apply to the village on both sides, and the order is
 * the sort column then id. Everything is bound as a parameter except the whitelisted column and direction.
 */
async function findIdsBySearch({ filters, sort, skip, take }: VillageListParams): Promise<{ ids: string[]; total: number }> {
  const pattern = `%${escapeLikePattern(filters.search ?? '')}%`;

  const conditions = [Prisma.sql`v.deleted_at IS NULL`];
  if (filters.governorateId) conditions.push(Prisma.sql`v.governorate_id = ${filters.governorateId}::uuid`);
  if (filters.localAuthorityId) conditions.push(Prisma.sql`v.local_authority_id = ${filters.localAuthorityId}::uuid`);
  if (filters.verificationStatus) {
    conditions.push(Prisma.sql`v.verification_status = ${filters.verificationStatus}::"VerificationStatus"`);
  }
  const where = Prisma.join(conditions, ' AND ');

  const matches = Prisma.sql`
    SELECT v.id FROM villages v
    WHERE ${where} AND (v.name_ar ILIKE ${pattern} OR v.name_en ILIKE ${pattern} OR v.slug ILIKE ${pattern})
    UNION
    SELECT v.id FROM village_names n
    JOIN villages v ON v.id = n.village_id
    WHERE ${where} AND n.deleted_at IS NULL AND n.name ILIKE ${pattern}
  `;

  const direction = sort.order === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  // Same as Prisma's `nulls: 'last'` for the nullable columns.
  const nulls = NULLABLE_SORT_FIELDS.has(sort.field) ? Prisma.sql`NULLS LAST` : Prisma.empty;

  const [countRows, idRows] = await prisma.$transaction([
    prisma.$queryRaw<{ total: bigint }[]>`SELECT count(*) AS total FROM (${matches}) AS m`,
    prisma.$queryRaw<{ id: string }[]>`
      SELECT v.id FROM (${matches}) AS m
      JOIN villages v ON v.id = m.id
      ORDER BY ${SORT_COLUMNS[sort.field]} ${direction} ${nulls}, v.id ASC
      LIMIT ${take} OFFSET ${skip}
    `,
  ]);

  return { ids: idRows.map((row) => row.id), total: Number(countRows[0]?.total ?? 0) };
}

function toListItem(row: Prisma.VillageGetPayload<{ select: ReturnType<typeof villageListSelect> }>): VillageListItem {
  return { ...row, latitude: toNumber(row.latitude), longitude: toNumber(row.longitude) };
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
    if (params.filters.search) {
      const { ids, total } = await findIdsBySearch(params);
      if (ids.length === 0) return { items: [], total };

      // The page is loaded with the same select as the list without a search, then put back in the sorted order.
      const rows = await prisma.village.findMany({ where: { id: { in: ids } }, select: villageListSelect() });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return { items: ids.flatMap((id) => byId.get(id) ?? []).map(toListItem), total };
    }

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

    return { items: rows.map(toListItem), total };
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

  async exists(id, client) {
    if (client) {
      // FOR SHARE also blocks non-key updates such as soft deletion; FK locks do not.
      const rows = await client.$queryRaw<{ id: string }[]>`
        SELECT id FROM villages WHERE id = ${id}::uuid AND deleted_at IS NULL FOR SHARE
      `;
      return rows.length > 0;
    }
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
