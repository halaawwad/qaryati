import type { AuditAction, Prisma } from '@prisma/client';
import { recordAudit } from '../audit/audit.service.js';

/** One audit entry for a village change. Snapshots may be Prisma rows; the adapter makes them JSON-safe. */
export interface VillageAuditEntry {
  entityType: string;
  entityId: string;
  action: AuditAction;
  actorId: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
}

/** What VillageService needs from the audit module. Tests pass a fake instead of the real one. */
export interface VillageAuditRecorder {
  /** Writes the audit row inside the caller's transaction so the change and its log commit together. */
  record(tx: Prisma.TransactionClient, entry: VillageAuditEntry): Promise<void>;
}

/**
 * Turns a snapshot into plain JSON: Decimal becomes a string, Date an ISO string, and
 * undefined/null become null (recordAudit stores that as SQL NULL).
 */
export function toAuditJson(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Default adapter over Sara's recordAudit(input, tx). */
export const villageAudit: VillageAuditRecorder = {
  async record(tx, entry) {
    await recordAudit(
      {
        entityType: entry.entityType,
        entityId: entry.entityId,
        action: entry.action,
        actorId: entry.actorId,
        before: toAuditJson(entry.before),
        after: toAuditJson(entry.after),
        requestId: entry.requestId,
      },
      tx,
    );
  },
};
