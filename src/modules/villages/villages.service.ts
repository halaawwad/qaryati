import {
  AuditAction,
  PlaceType,
  Prisma,
  Role,
  VerificationStatus,
  type PlaceRelation,
  type Village,
} from '@prisma/client';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors.js';

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
import { unprocessable, versionConflict, villageNotFound } from './villages.errors.js';
import { assertCanEdit } from './villages.permissions.js';
import { villageAudit, type VillageAuditRecorder } from './villages.audit.js';
import {
  geoEnrichmentInputSchema,
  type CreateVillageInput,
  type GeoEnrichmentInput,
  type ListVillagesQuery,
  type NearbyVillagesQuery,
  type UpdateVillageInput,
  type VillageVersionInput,
} from './villages.schemas.js';

/** Who is making a change, for createdById/updatedById, the audit log and the edit permissions (role). */
export interface WriteActor {
  userId: string;
  /** The role from the access token (req.user.role). */
  role: Role;
  requestId: string | null;
}

/** Like WriteActor, but userId is null for system jobs (e.g. a geo enrichment batch). */
interface ChangeActor {
  userId: string | null;
  requestId: string | null;
}

/** Same shape as req.user, so an authenticated caller can pass it straight through. */
export interface GeoEnrichmentActor {
  id: string;
  role: Role;
}

export interface GeoEnrichmentOptions {
  /** null for a system job: updatedById and the audit actorId are then null. */
  actor: GeoEnrichmentActor | null;
  /** Required with overwrite. Without it, the version read inside the transaction is used. */
  expectedVersion?: number;
  requestId?: string | null;
  /** Replace coordinates that are already set. REVIEWER or ADMIN only. */
  overwrite?: boolean;
}

export interface GeoEnrichmentVillage {
  id: string;
  version: number;
  latitude: number | null;
  longitude: number | null;
  geoDisplayName: string | null;
  geoEnrichedAt: Date | null;
  verificationStatus: VerificationStatus;
}

export type GeoEnrichmentResult =
  | { status: 'applied'; village: GeoEnrichmentVillage }
  | { status: 'skipped'; reason: 'COORDINATES_ALREADY_SET'; village: GeoEnrichmentVillage };

const GEO_OVERWRITE_ROLES: ReadonlySet<Role> = new Set([Role.REVIEWER, Role.ADMIN]);

/** Marks audit rows written by applyGeoEnrichment: `after.source`. */
const GEO_AUDIT_SOURCE = 'geo-enrichment';

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

function toGeoVillage(row: Village): GeoEnrichmentVillage {
  return {
    id: row.id,
    version: row.version,
    latitude: row.latitude?.toNumber() ?? null,
    longitude: row.longitude?.toNumber() ?? null,
    geoDisplayName: row.geoDisplayName,
    geoEnrichedAt: row.geoEnrichedAt,
    verificationStatus: row.verificationStatus,
  };
}

// Either half counts: a partially set point is still something a person entered, so it is never overwritten silently.
function hasCoordinates(row: Village): boolean {
  return row.latitude !== null || row.longitude !== null;
}

export class VillageService {
  constructor(
    private readonly repository: VillageRepository = villageRepository,
    private readonly audit: VillageAuditRecorder = villageAudit,
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
   * With a transaction client, holds a shared row lock until that transaction ends so that
   * deletion or modification cannot race a dependent write. Without one this is only a check.
   */
  async ensureExists(villageId: string, client?: Prisma.TransactionClient): Promise<void> {
    if (!UUID_PATTERN.test(villageId) || !(await this.repository.exists(villageId, client))) {
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
        // 404, then 403, then 409: who may edit is decided before the version is compared.
        const before = await this.loadForWrite(writes, id, version, (village) => assertCanEdit(village, actor));
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

  /**
   * Writes geocoding results (coordinates and display name) onto a village, for the maps module.
   * This is the only way geoDisplayName / geoEnrichedAt get written; nothing else should update villages directly.
   * There is no route for it: the maps module calls it from code.
   *
   * Call the geocoder (Nominatim) BEFORE calling this, never from inside it: this runs in a database
   * transaction, and a slow or failing HTTP call there would hold the row lock for the whole request.
   *
   * Rules, in the order they are checked:
   * 1. input must be valid: latitude and longitude required and within range, geoDisplayName a string of at most
   *    500 characters or null (default null). Otherwise 400 VALIDATION_ERROR. expectedVersion, if given, must be
   *    a positive integer (400).
   * 2. overwrite: true needs actor.role REVIEWER or ADMIN, else 403 (a system job, actor = null, can't overwrite),
   *    and needs expectedVersion, else 400. Both are checked before touching the database.
   * 3. The village must exist and not be soft-deleted, else 404 (also for an id that isn't a UUID).
   * 4. If expectedVersion is given and differs from the stored version: 409 VERSION_CONFLICT.
   * 5. If the village already has coordinates (either half) and overwrite is not true: nothing is written
   *    (not even geoDisplayName), no version bump, no audit row; returns { status: 'skipped',
   *    reason: 'COORDINATES_ALREADY_SET' } with the village as stored.
   * 6. Otherwise it applies latitude, longitude, geoDisplayName and geoEnrichedAt = now, bumps version, resets
   *    verificationStatus to PENDING (new data needs review) and sets updatedById to actor.id (null for a system job).
   *    The update is guarded by the version read in steps 3-4: if someone else changed the village in the
   *    meantime, it fails with 409 VERSION_CONFLICT instead of overwriting their edit.
   * 7. The change is audited in the same transaction: entityType 'village', action UPDATE, before and after,
   *    actorId = actor.id or null, and after.source = 'geo-enrichment'.
   *
   * Returns { status: 'applied', village } or { status: 'skipped', reason, village }.
   */
  async applyGeoEnrichment(
    villageId: string,
    input: GeoEnrichmentInput,
    options: GeoEnrichmentOptions,
  ): Promise<GeoEnrichmentResult> {
    const parsed = geoEnrichmentInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        'Invalid geo enrichment input',
        parsed.error.issues.map((issue) => ({ field: issue.path.map(String).join('.') || 'input', message: issue.message })),
      );
    }

    const { actor, expectedVersion, requestId = null, overwrite = false } = options;
    if (expectedVersion !== undefined && !(Number.isInteger(expectedVersion) && expectedVersion > 0)) {
      throw new ValidationError('Invalid geo enrichment options', [
        { field: 'expectedVersion', message: 'expectedVersion must be a positive integer' },
      ]);
    }
    if (overwrite && (!actor || !GEO_OVERWRITE_ROLES.has(actor.role))) {
      throw new ForbiddenError('Only reviewers and admins can overwrite existing coordinates');
    }
    if (overwrite && expectedVersion === undefined) {
      throw new ValidationError('Invalid geo enrichment options', [
        { field: 'expectedVersion', message: 'expectedVersion is required when overwrite is true' },
      ]);
    }
    if (!UUID_PATTERN.test(villageId)) throw villageNotFound();

    const changeActor: ChangeActor = { userId: actor?.id ?? null, requestId };
    const { latitude, longitude, geoDisplayName } = parsed.data;

    return this.repository.transaction(async (writes, tx): Promise<GeoEnrichmentResult> => {
      const before = await writes.findById(villageId);
      if (!before || before.deletedAt) throw villageNotFound();
      if (expectedVersion !== undefined && before.version !== expectedVersion) throw versionConflict(before.version);

      if (hasCoordinates(before) && !overwrite) {
        return { status: 'skipped', reason: 'COORDINATES_ALREADY_SET', village: toGeoVillage(before) };
      }

      const after = await this.applyVersioned(
        writes,
        tx,
        changeActor,
        AuditAction.UPDATE,
        before,
        before.version,
        { latitude, longitude, geoDisplayName, geoEnrichedAt: new Date(), verificationStatus: VerificationStatus.PENDING },
        { source: GEO_AUDIT_SOURCE },
      );

      return { status: 'applied', village: toGeoVillage(after) };
    });
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

  /**
   * Reads the row to change: 404 if missing or deleted, then `authorize` (403), then 409 if the client's
   * version is already stale. Nothing has been written at any of these points.
   */
  private async loadForWrite(
    writes: VillageWriteRepository,
    id: string,
    version: number,
    authorize?: (village: Village) => void,
  ): Promise<Village> {
    const before = await writes.findById(id);
    if (!before || before.deletedAt) throw villageNotFound();
    authorize?.(before);
    if (before.version !== version) throw versionConflict(before.version);

    return before;
  }

  /**
   * Optimistic locking: the update only matches { id, version, deletedAt: null }. If a concurrent request
   * changed the row after loadForWrite, nothing matches, and a fresh read tells 404 (deleted) from 409.
   * auditMeta is merged into the audit row's `after` (e.g. { source: 'geo-enrichment' }).
   */
  private async applyVersioned(
    writes: VillageWriteRepository,
    tx: Prisma.TransactionClient,
    actor: ChangeActor,
    action: AuditAction,
    before: Village,
    version: number,
    changes: VillageChanges,
    auditMeta?: Record<string, unknown>,
  ): Promise<Village> {
    const changed = await writes.updateIfVersion(before.id, version, changes, actor.userId);
    if (changed === 0) {
      const current = await writes.findById(before.id);
      if (!current || current.deletedAt) throw villageNotFound();
      throw versionConflict(current.version);
    }

    const after = await writes.findById(before.id);
    if (!after) throw villageNotFound();

    await this.recordAudit(tx, actor, action, before.id, before, auditMeta ? { ...after, ...auditMeta } : after);
    return after;
  }

  private recordAudit(
    tx: Prisma.TransactionClient,
    actor: ChangeActor,
    action: AuditAction,
    entityId: string,
    before: Village | null,
    after: unknown,
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
