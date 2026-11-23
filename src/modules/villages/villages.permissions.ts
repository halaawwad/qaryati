import { Role, VerificationStatus } from '@prisma/client';
import { AppError } from '../../shared/errors.js';

/** What the edit rule needs to know about a record: who created it and where it is in the review. */
export interface EditableRecord {
  createdById: string | null;
  verificationStatus: VerificationStatus;
}

/** The part of the caller the rule looks at. WriteActor has more, and is assignable to this. */
export interface EditActor {
  userId: string;
  role: Role;
}

/** Used in the messages, so a refused edit of a name does not talk about a village. */
export type EditableEntity = 'village' | 'alternate name';

// Two different 403s with their own codes, so a client can tell "this is not yours" from "propose it as a
// change request instead". AppError rather than ForbiddenError, which always carries the code FORBIDDEN.
export function villageEditForbidden(entity: EditableEntity = 'village'): AppError {
  return new AppError(403, 'VILLAGE_EDIT_FORBIDDEN', `You can only edit ${entity}s that you created`, [
    { field: 'id', message: `This ${entity} was created by someone else` },
  ]);
}

export function changeRequestRequired(status: VerificationStatus, entity: EditableEntity = 'village'): AppError {
  return new AppError(
    403,
    'CHANGE_REQUEST_REQUIRED',
    `A ${status} ${entity} cannot be edited directly; submit the change as a change request`,
    [{ field: 'verificationStatus', message: `The ${entity} is ${status}` }],
  );
}

/**
 * Who may edit a record directly (PATCH), checked after the record is loaded and before the version is compared:
 * - REVIEWER and ADMIN: always.
 * - EDITOR: only a record they created that is still PENDING. A VERIFIED or REJECTED record, whoever created it,
 *   has to be changed through a change request; a PENDING record of someone else is not theirs to edit.
 * Used for villages and for their alternate names, which have the same createdById and verificationStatus.
 */
export function assertCanEdit(record: EditableRecord, actor: EditActor, entity: EditableEntity = 'village'): void {
  if (actor.role === Role.REVIEWER || actor.role === Role.ADMIN) return;

  if (record.verificationStatus !== VerificationStatus.PENDING) {
    throw changeRequestRequired(record.verificationStatus, entity);
  }
  if (record.createdById !== actor.userId) throw villageEditForbidden(entity);
}
