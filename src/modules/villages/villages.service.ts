import { PlaceType, type PlaceRelation } from '@prisma/client';
import { AppError, NotFoundError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination, type PaginationMeta } from '../../shared/pagination.js';
import {
  villageRepository,
  type NearbyPlaceRow,
  type VillageDetails,
  type VillageListItem,
  type VillageLookup,
  type VillageRef,
  type VillageRepository,
  type VillageWithinRadius,
} from './villages.repository.js';
import type { ListVillagesQuery, NearbyVillagesQuery } from './villages.schemas.js';

export interface VillageListResult {
  items: VillageListItem[];
  meta: PaginationMeta;
}

/** A recorded relation seen from the requested village, whichever side it was stored on. */
export interface NearbyPlace {
  placeName: string;
  placeType: PlaceType;
  relation: PlaceRelation;
  distanceKm: number | null;
  village: VillageRef | null;
}

const DEFAULT_SORT = 'nameAr';
const DEFAULT_ORDER = 'asc';

// Any UUID shape Postgres accepts; anything else is treated as a slug and never reaches a uuid column.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toLookup(idOrSlug: string): VillageLookup {
  return UUID_PATTERN.test(idOrSlug) ? { id: idOrSlug } : { slug: idOrSlug };
}

function activeVillage(village: (VillageRef & { deletedAt: Date | null }) | null): VillageRef | null {
  if (!village || village.deletedAt) return null;

  const { deletedAt: _deletedAt, ...ref } = village;
  return ref;
}

function toNearbyPlace(row: NearbyPlaceRow, villageId: string): NearbyPlace {
  const common = { relation: row.relation, distanceKm: row.distanceKm };

  // Stored on this village: the row describes the other place.
  if (row.villageId === villageId) {
    return {
      ...common,
      placeName: row.placeName,
      placeType: row.placeType,
      village: activeVillage(row.relatedVillage),
    };
  }

  // Stored on the other village, pointing back here: the place is that other village.
  return {
    ...common,
    placeName: row.village.nameAr,
    placeType: PlaceType.VILLAGE,
    village: activeVillage(row.village),
  };
}

export class VillageService {
  constructor(private readonly repository: VillageRepository = villageRepository) {}

  async list(query: ListVillagesQuery): Promise<VillageListResult> {
    const pagination = parsePagination(query);

    const { items, total } = await this.repository.findMany({
      filters: {
        search: query.search,
        governorateId: query.governorateId,
        localAuthorityId: query.localAuthorityId,
        verificationStatus: query.verificationStatus,
      },
      sort: { field: query.sort ?? DEFAULT_SORT, order: query.order ?? DEFAULT_ORDER },
      skip: pagination.skip,
      take: pagination.take,
    });

    return { items, meta: buildPaginationMeta(total, pagination) };
  }

  async getByIdOrSlug(idOrSlug: string): Promise<VillageDetails> {
    const village = await this.repository.findDetails(toLookup(idOrSlug));
    if (!village) {
      throw new NotFoundError('Village not found');
    }

    return village;
  }

  /**
   * Without radiusKm: the relations recorded in nearby_places, in both directions.
   * With radiusKm: villages whose coordinates are within that distance, nearest first.
   */
  async listNearby(idOrSlug: string, query: NearbyVillagesQuery): Promise<NearbyPlace[] | VillageWithinRadius[]> {
    const village = await this.repository.findLocation(toLookup(idOrSlug));
    if (!village) {
      throw new NotFoundError('Village not found');
    }

    if (query.radiusKm === undefined) {
      const rows = await this.repository.findNearbyPlaceRows(village.id);
      return rows.map((row) => toNearbyPlace(row, village.id));
    }

    if (village.latitude === null || village.longitude === null) {
      throw new AppError(
        422,
        'VILLAGE_HAS_NO_COORDINATES',
        'This village has no coordinates yet, so nearby villages cannot be calculated by distance',
      );
    }

    return this.repository.findVillagesWithinRadius({
      villageId: village.id,
      latitude: village.latitude,
      longitude: village.longitude,
      radiusKm: query.radiusKm,
    });
  }

  /**
   * Throws NotFoundError (404) unless the village exists and is not soft-deleted.
   *
   * Call this before creating or changing rows that belong to a village (population records,
   * landmarks, heritage items, ...), so that a missing or deleted village returns 404 instead of
   * a foreign-key error or a row attached to a hidden village. Ids that are not UUIDs are
   * rejected without querying the database.
   *
   * This is a check, not a lock: it does not stop the village from being soft-deleted afterwards.
   */
  async ensureExists(villageId: string): Promise<void> {
    if (!UUID_PATTERN.test(villageId) || !(await this.repository.exists(villageId))) {
      throw new NotFoundError('Village not found');
    }
  }
}

export const villageService = new VillageService();
