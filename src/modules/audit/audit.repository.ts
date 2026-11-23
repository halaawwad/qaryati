import { Prisma, type AuditAction, type AuditLog } from '@prisma/client';
import { prisma } from '../../shared/db.js';

export interface RecordAuditInput {
  entityType: string;
  entityId: string;
  action: AuditAction;
  actorId?: string | null;
  /** Explicitly selected, JSON-compatible fields only; never pass secrets or request objects. */
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  requestId?: string | null;
}

export interface AuditRepository {
  create(input: RecordAuditInput, client?: Prisma.TransactionClient): Promise<AuditLog>;
}

export const auditRepository: AuditRepository = {
  async create(input, client = prisma) {
    return client.auditLog.create({
      data: {
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        actorId: input.actorId,
        // Missing snapshots and top-level null represent SQL NULL, not JSON null.
        before: input.before ?? Prisma.DbNull,
        after: input.after ?? Prisma.DbNull,
        requestId: input.requestId,
      },
    });
  },
};
