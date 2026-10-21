// Minimal version so village writes can be audited. Owned by Sara; extend freely.

import { Prisma, type AuditAction } from '@prisma/client';

export interface AuditEntry {
  entityType: string;
  entityId: string;
  action: AuditAction;
  actorId: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
}

export interface AuditRecorder {
  /** Writes one audit_logs row inside the caller's transaction, so the change and its log commit together. */
  record(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void>;
}

// Round-trips through JSON so Decimal, Date and other Prisma values become plain JSON,
// and maps null/undefined to a database NULL (Prisma rejects a bare null for Json? columns).
function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === null || value === undefined) return Prisma.DbNull;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export const auditService: AuditRecorder = {
  async record(tx, entry) {
    await tx.auditLog.create({
      data: {
        entityType: entry.entityType,
        entityId: entry.entityId,
        action: entry.action,
        actorId: entry.actorId,
        before: toJson(entry.before),
        after: toJson(entry.after),
        requestId: entry.requestId,
      },
    });
  },
};
