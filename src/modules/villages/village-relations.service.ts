import {
  AuditAction,
  PlaceType,
  Prisma,
  VerificationStatus,
  type NearbyPlace as NearbyPlaceRecord,
  type VillageName,
} from '@prisma/client';
import { auditService, type AuditRecorder } from '../audit/audit.service.js';
import { AppError, NotFoundError, ValidationError } from '../../shared/errors.js';
import {
  villageRepository,
  type NearbyPlaceCreateData,
  type VillageNameWriteData,
  type VillageRepository,
  type VillageWriteRepository,
} from './villages.repository.js';
import { unprocessable, versionConflict, villageNotFound } from './villages.errors.js';
import type { CreateNearbyPlaceInput, CreateVillageNameInput, UpdateVillageNameInput } from './villages.schemas.js';
import type { WriteActor } from './villages.service.js';

export type VillageNameResponse = Omit<VillageName, 'createdById' | 'updatedById' | 'deletedAt'>;
export type NearbyPlaceResponse = Omit<NearbyPlaceRecord, 'distanceKm'> & { distanceKm: number | null };

function nameNotFound(): NotFoundError {
  return new NotFoundError('Village name not found');
}

function relationNotFound(): NotFoundError {
  return new NotFoundError('Nearby relation not found');
}

function relationExists(): AppError {
  return new AppError(409, 'NEARBY_RELATION_EXISTS', 'These two villages are already related', [
    { field: 'relatedVillageId', message: 'A relation between these villages already exists (in either direction)' },
  ]);
}

function placeNameExists(): AppError {
  return new AppError(409, 'NEARBY_PLACE_NAME_EXISTS', 'This village already has a nearby place with this name', [
    { field: 'placeName', message: 'Place name is already used for this village' },
  ]);
}

function selfRelation(): AppError {
  return unprocessable('NEARBY_SELF_RELATION', 'relatedVillageId', 'A village cannot be nearby to itself');
}

/**
 * Backstop for races the pre-checks can't close. Verified against the real database:
 * - the (village_id, place_name) unique key comes back as P2002 with target ["village_id", "place_name"];
 * - the pair index on (LEAST, GREATEST) is an expression index Prisma doesn't model, but Postgres still reports
 *   a unique violation, which Prisma surfaces as P2002 with the expression split into pieces
 *   (["LEAST(village_id", "related_village_id)", ...]);
 * - the not-self CHECK constraint is not a known Prisma error at all: it arrives as
 *   PrismaClientUnknownRequestError with no code, so it can only be recognised by its constraint name.
 */
function nearbyConstraintViolation(err: unknown): AppError | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = String(err.meta?.target ?? '');
    if (target.includes('LEAST') || target.includes('GREATEST')) return relationExists();
    if (target.includes('place_name') || target.includes('placeName')) return placeNameExists();
  }

  if (err instanceof Prisma.PrismaClientUnknownRequestError && err.message.includes('nearby_places_not_self_check')) {
    return selfRelation();
  }

  return null;
}

function toNameResponse(row: VillageName): VillageNameResponse {
  const { createdById: _createdById, updatedById: _updatedById, deletedAt: _deletedAt, ...name } = row;
  return name;
}

function toNearbyResponse(row: NearbyPlaceRecord): NearbyPlaceResponse {
  return { ...row, distanceKm: row.distanceKm?.toNumber() ?? null };
}

async function loadActiveVillage(writes: VillageWriteRepository, villageId: string) {
  const village = await writes.findById(villageId);
  if (!village || village.deletedAt) throw villageNotFound();

  return village;
}

/** A name of another village is reported exactly like a missing one, so ids of other villages' names don't leak. */
async function loadName(writes: VillageWriteRepository, villageId: string, nameId: string): Promise<VillageName> {
  const name = await writes.findNameById(nameId);
  if (!name || name.deletedAt || name.villageId !== villageId) throw nameNotFound();

  return name;
}

/** Rules on the final state of a name: for an update, fields missing from the body keep their stored value. */
async function assertNameRules(
  writes: VillageWriteRepository,
  villageId: string,
  changes: VillageNameWriteData,
  current: VillageName | null,
): Promise<void> {
  const name = changes.name ?? current?.name ?? '';
  const language = changes.language ?? current?.language ?? '';
  const periodFrom = changes.periodFrom !== undefined ? changes.periodFrom : (current?.periodFrom ?? null);
  const periodTo = changes.periodTo !== undefined ? changes.periodTo : (current?.periodTo ?? null);

  // The schema only sees the body; a PATCH that sends one end of the period is checked against the stored other end.
  if (periodFrom !== null && periodTo !== null && periodFrom > periodTo) {
    throw new ValidationError('Request validation failed', [
      { field: 'periodFrom', message: 'periodFrom must be less than or equal to periodTo' },
    ]);
  }

  // Only checked when the source is being set, so an unrelated edit isn't blocked by a source deleted later.
  if (changes.sourceId && !(await writes.sourceExists(changes.sourceId))) {
    throw unprocessable('SOURCE_NOT_FOUND', 'sourceId', 'Source does not exist');
  }

  // village_names has no unique constraint, so duplicates are prevented here, inside the transaction.
  // This is not race-proof: two requests adding the same name at the same moment can both pass this check
  // (READ COMMITTED doesn't see the other's uncommitted insert). Closing that gap needs a unique index
  // (e.g. on village_id, language, lower(name) WHERE deleted_at IS NULL), which is a schema change.
  if (changes.name !== undefined || changes.language !== undefined) {
    if (await writes.nameTaken(villageId, name, language, current?.id)) {
      throw new AppError(409, 'VILLAGE_NAME_EXISTS', 'This village already has this name in this language', [
        { field: 'name', message: 'Name already exists for this village and language' },
      ]);
    }
  }
}

export class VillageRelationsService {
  constructor(
    private readonly repository: VillageRepository = villageRepository,
    private readonly audit: AuditRecorder = auditService,
  ) {}

  // --- Alternate names: soft delete and optimistic locking, like villages ---

  /** New names start as PENDING at version 1 (database defaults). */
  async addName(villageId: string, input: CreateVillageNameInput, actor: WriteActor): Promise<VillageNameResponse> {
    return this.repository.transaction(async (writes, tx) => {
      await loadActiveVillage(writes, villageId);
      await assertNameRules(writes, villageId, input, null);

      const created = await writes.createName({ ...input, villageId, createdById: actor.userId });
      await this.recordAudit(tx, actor, 'village_name', AuditAction.CREATE, created.id, null, created);
      return toNameResponse(created);
    });
  }

  /** Any edit bumps version and sends the name back to PENDING for review. */
  async updateName(
    villageId: string,
    nameId: string,
    input: UpdateVillageNameInput,
    actor: WriteActor,
  ): Promise<VillageNameResponse> {
    const { version, ...changes } = input;

    return this.repository.transaction(async (writes, tx) => {
      await loadActiveVillage(writes, villageId);
      const before = await loadName(writes, villageId, nameId);
      if (before.version !== version) throw versionConflict(before.version, 'village name');

      await assertNameRules(writes, villageId, changes, before);

      const changed = await writes.updateNameIfVersion(
        nameId,
        version,
        { ...changes, verificationStatus: VerificationStatus.PENDING },
        actor.userId,
      );
      if (changed === 0) {
        // Changed or deleted by a concurrent request after loadName.
        const current = await writes.findNameById(nameId);
        if (!current || current.deletedAt) throw nameNotFound();
        throw versionConflict(current.version, 'village name');
      }

      const after = await writes.findNameById(nameId);
      if (!after) throw nameNotFound();

      await this.recordAudit(tx, actor, 'village_name', AuditAction.UPDATE, nameId, before, after);
      return toNameResponse(after);
    });
  }

  /** Soft delete: the name stays for history but disappears from village details and search. */
  async removeName(villageId: string, nameId: string, actor: WriteActor): Promise<void> {
    await this.repository.transaction(async (writes, tx) => {
      await loadActiveVillage(writes, villageId);
      const before = await loadName(writes, villageId, nameId);

      if ((await writes.softDeleteName(nameId, actor.userId)) === 0) throw nameNotFound();

      const after = await writes.findNameById(nameId);
      await this.recordAudit(tx, actor, 'village_name', AuditAction.DELETE, nameId, before, after);
    });
  }

  // --- Nearby places: hard delete, no version (team decision) ---
  // nearby_places has no source column in the schema, so these rows are an exception to the
  // "no fact without a source" rule. That exception was the team's decision, not this module's.

  async addNearby(villageId: string, input: CreateNearbyPlaceInput, actor: WriteActor): Promise<NearbyPlaceResponse> {
    // Checked before any query: the database would only report it as an uncoded CHECK violation.
    if ('relatedVillageId' in input && input.relatedVillageId === villageId) throw selfRelation();

    try {
      return await this.repository.transaction(async (writes, tx) => {
        await loadActiveVillage(writes, villageId);

        let data: NearbyPlaceCreateData;
        if ('relatedVillageId' in input) {
          const related = await writes.findById(input.relatedVillageId);
          if (!related || related.deletedAt) {
            throw unprocessable('RELATED_VILLAGE_NOT_FOUND', 'relatedVillageId', 'Related village does not exist');
          }
          // The pair is stored once, whichever village it was recorded from.
          if (await writes.findRelationBetween(villageId, related.id)) throw relationExists();

          data = {
            villageId,
            relatedVillageId: related.id,
            placeName: related.nameAr,
            placeType: PlaceType.VILLAGE,
            relation: input.relation,
            distanceKm: input.distanceKm ?? null,
          };
        } else {
          data = {
            villageId,
            relatedVillageId: null,
            placeName: input.placeName,
            placeType: input.placeType,
            relation: input.relation,
            distanceKm: input.distanceKm ?? null,
          };
        }

        if (await writes.placeNameTaken(villageId, data.placeName)) throw placeNameExists();

        const created = await writes.createNearby(data);
        await this.recordAudit(tx, actor, 'nearby_place', AuditAction.CREATE, created.id, null, created);
        return toNearbyResponse(created);
      });
    } catch (err) {
      throw nearbyConstraintViolation(err) ?? err;
    }
  }

  /**
   * Hard delete. The audit row keeps the full `before`, which is what makes a hard delete acceptable:
   * the relation can be restored from the log.
   */
  async removeNearby(villageId: string, relationId: string, actor: WriteActor): Promise<void> {
    await this.repository.transaction(async (writes, tx) => {
      await loadActiveVillage(writes, villageId);

      // The relation must involve the village in the URL, on either side; anything else is a 404.
      const before = await writes.findNearbyById(relationId);
      if (!before || (before.villageId !== villageId && before.relatedVillageId !== villageId)) {
        throw relationNotFound();
      }

      if ((await writes.deleteNearby(relationId)) === 0) throw relationNotFound();

      await this.recordAudit(tx, actor, 'nearby_place', AuditAction.DELETE, relationId, before, null);
    });
  }

  private recordAudit(
    tx: Prisma.TransactionClient,
    actor: WriteActor,
    entityType: 'village_name' | 'nearby_place',
    action: AuditAction,
    entityId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    return this.audit.record(tx, {
      entityType,
      entityId,
      action,
      actorId: actor.userId,
      before,
      after,
      requestId: actor.requestId,
    });
  }
}

export const villageRelationsService = new VillageRelationsService();
