import type { AuditLog, Prisma } from '@prisma/client';
import { ValidationError, type ErrorDetail } from '../../shared/errors.js';
import { auditRepository, type RecordAuditInput } from './audit.repository.js';

export type { RecordAuditInput } from './audit.repository.js';

/**
 * Records only the supplied audit fields. Callers must select safe snapshots explicitly.
 * Pass the business transaction's client to make both writes atomic; errors propagate.
 */
export async function recordAudit(
  input: RecordAuditInput,
  client?: Prisma.TransactionClient,
): Promise<AuditLog> {
  const details: ErrorDetail[] = [];
  for (const field of ['entityType', 'entityId'] as const) {
    const value = input[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      details.push({ field, message: 'Must be a non-empty string' });
    }
  }
  if (details.length > 0) {
    throw new ValidationError('Invalid audit input', details);
  }

  return auditRepository.create(input, client);
}
