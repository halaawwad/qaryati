import {
  AuditAction,
  PlaceType,
  Prisma,
  VerificationStatus,
  type PlaceRelation,
  type Village,
} from '@prisma/client';
import { auditService, type AuditRecorder } from '../audit/audit.service.js';
import { AppError, NotFoundError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination, type PaginationMeta } from '../../shared/pagination.js';
import {
  villageRepository,
  type NearbyPlaceRow,
  type VillageChanges,
  type VillageDetails,
  type VillageListItem,
  type VillageLookup,
  type VillageRef,
  type VillageRepository,
  type VillageWithinRadius,
  type VillageWriteData,
  type VillageWriteRepository,
} from './villages.repository.js';
import type {
  CreateVillageInput,
  ListVillagesQuery,
  NearbyVillagesQuery,
  UpdateVillageInput,
  VillageVersionInput,
} from './villages.schemas.js';

/** Who is making a change, for createdById/updatedById and the audit log. */
export interface WriteActor {
  userId: string;
  requestId: string | null;
}

const AUDIT_ENTITY_TYPE = 'village';

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

function villageNotFound(): NotFoundError {
  return new NotFoundError('Village not found');
}

function versionConflict(currentVersion: number): AppError {
  return new AppError(409, 'VERSION_CONFLICT', 'The village was changed by someone else; reload it and retry', [
    { field: 'version', message: `Current version is ${currentVersion}` },
  ]);
}

function unprocessable(code: string, field: string, message: string): AppError {
  return new AppError(422, code, message, [{ field, message }]);
}

// The unique constraints are the real guard against duplicates (a pre-check would race with a
// concurrent insert), so a P2002 from the database is translated into a 409 for the right field.
function uniqueViolation(err: unknown): AppError | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return null;

  const target = String(err.meta?.target ?? '');
  if (target.includes('slug')) {
    return new AppError(409, 'SLUG_TAKEN', 'Another village already uses this slug', [
      { field: 'slug', message: 'Slug is already taken' },
    ]);
  }
  if (target.includes('pcbs')) {
    return new AppError(409, 'PCBS_CODE_TAKEN', 'Another village already uses this PCBS code', [
      { field: 'pcbsCode', message: 'PCBS code is already taken' },
    ]);
  }

  return null;
}

/**
 * Cross-field and cross-table rules for a create (current = null) or an update (current = stored row).
 * On updates, fields missing from the body keep their stored value, so the rules apply to the final state.
 */
async function assertConsistent(
  writes: VillageWriteRepository,
  changes: VillageWriteData,
  current: Village | null,
): Promise<void> {
  const governorateId = changes.governorateId ?? current?.governorateId;
  const localAuthorityId =
    changes.localAuthorityId !== undefined ? changes.localAuthorityId : (current?.localAuthorityId ?? null);
  const nameOrigin = changes.nameOrigin !== undefined ? changes.nameOrigin : (current?.nameOrigin ?? null);
  const nameOriginSourceId =
    changes.nameOriginSourceId !== undefined ? changes.nameOriginSourceId : (current?.nameOriginSourceId ?? null);

  // The governorate is a required foreign key; a clear 422 is more useful than a raw FK error.
  if (changes.governorateId !== undefined && !(await writes.governorateExists(changes.governorateId))) {
    throw unprocessable('GOVERNORATE_NOT_FOUND', 'governorateId', 'Governorate does not exist');
  }

  // A village's local authority must belong to the village's own governorate, or the two filters
  // (?governorateId= and ?localAuthorityId=) would disagree about where the village is. Checked when
  // either side changes, so moving a village to another governorate can't leave it under the old council.
  if (localAuthorityId && (changes.localAuthorityId !== undefined || changes.governorateId !== undefined)) {
    const authorityGovernorateId = await writes.findLocalAuthorityGovernorateId(localAuthorityId);
    if (authorityGovernorateId === null) {
      throw unprocessable('LOCAL_AUTHORITY_NOT_FOUND', 'localAuthorityId', 'Local authority does not exist');
    }
    if (authorityGovernorateId !== governorateId) {
      throw unprocessable(
        'LOCAL_AUTHORITY_GOVERNORATE_MISMATCH',
        'localAuthorityId',
        "Local authority does not belong to the village's governorate",
      );
    }
  }

  // "No fact without a source": a name origin is a historical claim, so it must cite where it comes from.
  if (nameOrigin && !nameOriginSourceId) {
    throw unprocessable('NAME_ORIGIN_REQUIRES_SOURCE', 'nameOriginSourceId', 'nameOrigin requires nameOriginSourceId');
  }

  // Only checked when the source is being set, so an unrelated edit isn't blocked by a source deleted later.
  if (changes.nameOriginSourceId && !(await writes.sourceExists(changes.nameOriginSourceId))) {
    throw unprocessable('SOURCE_NOT_FOUND', 'nameOriginSourceId', 'Source does not exist');
  }
}

export class VillageService {
  constructor(
    private readonly repository: VillageRepository = villageRepository,
    private readonly audit: AuditRecorder = auditService,
  ) {}

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

  /** New villages start as PENDING at version 1 (database defaults). */
  async create(input: CreateVillageInput, actor: WriteActor): Promise<VillageDetails> {
    const id = await this.withUniqueChecks(() =>
      this.repository.transaction(async (writes, tx) => {
        await assertConsistent(writes, input, null);
        const created = await writes.create({ ...input, createdById: actor.userId });
        await this.recordAudit(tx, actor, AuditAction.CREATE, created.id, null, created);
        return created.id;
      }),
    );

    return this.getByIdOrSlug(id);
  }

  /** Any edit bumps version and sends the village back to PENDING for review. */
  async update(id: string, input: UpdateVillageInput, actor: WriteActor): Promise<VillageDetails> {
    const { version, ...changes } = input;

    await this.withUniqueChecks(() =>
      this.repository.transaction(async (writes, tx) => {
        const before = await this.loadForWrite(writes, id, version);
        await assertConsistent(writes, changes, before);
        await this.applyVersioned(writes, tx, actor, AuditAction.UPDATE, before, version, {
          ...changes,
          verificationStatus: VerificationStatus.PENDING,
        });
      }),
    );

    return this.getByIdOrSlug(id);
  }

  /** Soft delete: the row stays for history but disappears from every read. */
  async remove(id: string, actor: WriteActor): Promise<void> {
    await this.repository.transaction(async (writes, tx) => {
      const before = await writes.findById(id);
      if (!before || before.deletedAt) throw villageNotFound();

      // 0 means another request deleted it between the read and this write.
      if ((await writes.softDelete(id, actor.userId)) === 0) throw villageNotFound();

      const after = await writes.findById(id);
      await this.recordAudit(tx, actor, AuditAction.DELETE, id, before, after);
    });
  }

  verify(id: string, input: VillageVersionInput, actor: WriteActor): Promise<VillageDetails> {
    return this.setVerificationStatus(id, input.version, VerificationStatus.VERIFIED, AuditAction.VERIFY, actor);
  }

  reject(id: string, input: VillageVersionInput, actor: WriteActor): Promise<VillageDetails> {
    return this.setVerificationStatus(id, input.version, VerificationStatus.REJECTED, AuditAction.REJECT, actor);
  }

  // A status change is a change too: it bumps version, so an editor holding the old version gets a 409
  // instead of silently editing a village that was just reviewed.
  private async setVerificationStatus(
    id: string,
    version: number,
    status: VerificationStatus,
    action: AuditAction,
    actor: WriteActor,
  ): Promise<VillageDetails> {
    await this.repository.transaction(async (writes, tx) => {
      const before = await this.loadForWrite(writes, id, version);
      await this.applyVersioned(writes, tx, actor, action, before, version, { verificationStatus: status });
    });

    return this.getByIdOrSlug(id);
  }

  /** Reads the row to change: 404 if missing or deleted, 409 if the client's version is already stale. */
  private async loadForWrite(writes: VillageWriteRepository, id: string, version: number): Promise<Village> {
    const before = await writes.findById(id);
    if (!before || before.deletedAt) throw villageNotFound();
    if (before.version !== version) throw versionConflict(before.version);

    return before;
  }

  /**
   * Optimistic locking: the update only matches { id, version, deletedAt: null }. If a concurrent request
   * changed the row after loadForWrite, nothing matches, and a fresh read tells 404 (deleted) from 409.
   */
  private async applyVersioned(
    writes: VillageWriteRepository,
    tx: Prisma.TransactionClient,
    actor: WriteActor,
    action: AuditAction,
    before: Village,
    version: number,
    changes: VillageChanges,
  ): Promise<void> {
    const changed = await writes.updateIfVersion(before.id, version, changes, actor.userId);
    if (changed === 0) {
      const current = await writes.findById(before.id);
      if (!current || current.deletedAt) throw villageNotFound();
      throw versionConflict(current.version);
    }

    const after = await writes.findById(before.id);
    await this.recordAudit(tx, actor, action, before.id, before, after);
  }

  private recordAudit(
    tx: Prisma.TransactionClient,
    actor: WriteActor,
    action: AuditAction,
    entityId: string,
    before: Village | null,
    after: Village | null,
  ): Promise<void> {
    return this.audit.record(tx, {
      entityType: AUDIT_ENTITY_TYPE,
      entityId,
      action,
      actorId: actor.userId,
      before,
      after,
      requestId: actor.requestId,
    });
  }

  private async withUniqueChecks<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw uniqueViolation(err) ?? err;
    }
  }
}

export const villageService = new VillageService();
