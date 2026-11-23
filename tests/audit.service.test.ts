import { AuditAction, Prisma, type AuditLog } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordAudit, type RecordAuditInput } from '../src/modules/audit/audit.service.js';
import { ValidationError } from '../src/shared/errors.js';

const db = vi.hoisted(() => ({ auditLog: { create: vi.fn() } }));

// Replace the shared module entirely so no environment config or database is loaded.
vi.mock('../src/shared/db.js', () => ({ prisma: db }));

function input(): RecordAuditInput {
  return {
    entityType: 'Village',
    entityId: 'village-1',
    action: AuditAction.UPDATE,
    actorId: '11111111-1111-4111-8111-111111111111',
    before: { name: 'Old', nested: { value: null } },
    after: { name: 'New' },
    requestId: 'request-1',
  };
}

function row(): AuditLog {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    entityType: 'Village', entityId: 'village-1', action: AuditAction.UPDATE,
    actorId: null, before: null, after: null, requestId: null,
    createdAt: new Date('2026-11-02T00:00:00Z'),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  db.auditLog.create.mockResolvedValue(row());
});

describe('recordAudit', () => {
  it('returns the created audit record and passes exactly the supplied fields', async () => {
    const data = input();
    const result = row();
    db.auditLog.create.mockResolvedValue(result);

    await expect(recordAudit(data)).resolves.toBe(result);
    expect(db.auditLog.create).toHaveBeenCalledExactlyOnceWith({ data });
  });

  it.each([undefined, null])('maps absent or null snapshots (%j) to SQL NULL', async (snapshot) => {
    await recordAudit({
      entityType: 'Village', entityId: 'village-1', action: AuditAction.CREATE,
      before: snapshot, after: snapshot,
    });
    expect(db.auditLog.create).toHaveBeenCalledExactlyOnceWith({
      data: {
        entityType: 'Village', entityId: 'village-1', action: AuditAction.CREATE,
        actorId: undefined, requestId: undefined,
        before: Prisma.DbNull, after: Prisma.DbNull,
      },
    });
  });

  it('supports omitted snapshots and explicitly null optional identifiers', async () => {
    await recordAudit({
      entityType: 'Village', entityId: 'village-1', action: AuditAction.DELETE,
      actorId: null, requestId: null,
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: {
        entityType: 'Village', entityId: 'village-1', action: AuditAction.DELETE,
        actorId: null, requestId: null, before: Prisma.DbNull, after: Prisma.DbNull,
      },
    });
  });

  it.each([false, 0, ''])('preserves falsy JSON snapshots (%j)', async (snapshot) => {
    await recordAudit({ ...input(), before: snapshot, after: snapshot });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: { ...input(), before: snapshot, after: snapshot },
    });
  });

  it('uses the supplied transaction client instead of the global client', async () => {
    const result = row();
    const tx = { auditLog: { create: vi.fn().mockResolvedValue(result) } };
    await expect(recordAudit(input(), tx as unknown as Prisma.TransactionClient)).resolves.toBe(result);
    expect(tx.auditLog.create).toHaveBeenCalledExactlyOnceWith({ data: input() });
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('propagates the original database error', async () => {
    const error = new Error('Audit write failed');
    db.auditLog.create.mockRejectedValue(error);
    await expect(recordAudit(input())).rejects.toBe(error);
  });

  it('propagates transaction errors without falling back to the global client', async () => {
    const error = new Error('Transaction write failed');
    const tx = { auditLog: { create: vi.fn().mockRejectedValue(error) } };
    await expect(recordAudit(input(), tx as unknown as Prisma.TransactionClient)).rejects.toBe(error);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  describe.each(['entityType', 'entityId'] as const)('%s validation', (field) => {
    it.each(['', '   ', '\t\n', undefined, null, 42])('rejects invalid value %j before writing', async (value) => {
      const data = { ...input(), [field]: value } as unknown as RecordAuditInput;
      const promise = recordAudit(data);
      await expect(promise).rejects.toBeInstanceOf(ValidationError);
      await expect(promise).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ field, message: 'Must be a non-empty string' }],
      });
      expect(db.auditLog.create).not.toHaveBeenCalled();
    });
  });

  it('reports both invalid fields together', async () => {
    await expect(recordAudit({ ...input(), entityType: '', entityId: ' ' })).rejects.toMatchObject({
      details: [
        { field: 'entityType', message: 'Must be a non-empty string' },
        { field: 'entityId', message: 'Must be a non-empty string' },
      ],
    });
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('validates without trimming or mutating valid identifiers', async () => {
    const data = { ...input(), entityType: ' Village ', entityId: ' village-1 ' };
    await recordAudit(data);
    expect(db.auditLog.create).toHaveBeenCalledWith({ data });
    expect(data.entityType).toBe(' Village ');
    expect(data.entityId).toBe(' village-1 ');
  });
});
