import { AuditAction, Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VillageAuditEntry } from '../src/modules/villages/villages.audit.js';

const audit = vi.hoisted(() => ({ recordAudit: vi.fn() }));

vi.mock('../src/modules/audit/audit.service.js', () => audit);

const tx = {} as Prisma.TransactionClient;

function entry(overrides: Partial<VillageAuditEntry> = {}): VillageAuditEntry {
  return {
    entityType: 'village',
    entityId: '11111111-1111-4111-8111-111111111111',
    action: AuditAction.UPDATE,
    actorId: '22222222-2222-4222-8222-222222222222',
    before: null,
    after: null,
    requestId: 'request-1',
    ...overrides,
  };
}

describe('toAuditJson', () => {
  it('converts Decimal and Date to JSON-safe values and keeps nested data', async () => {
    const { toAuditJson } = await import('../src/modules/villages/villages.audit.js');

    const json = toAuditJson({
      latitude: new Prisma.Decimal('32.2211'),
      createdAt: new Date('2026-11-01T10:00:00.000Z'),
      nested: { name: 'Qaryati', missing: undefined, empty: null },
    });

    expect(json).toEqual({
      latitude: '32.2211',
      createdAt: '2026-11-01T10:00:00.000Z',
      nested: { name: 'Qaryati', empty: null },
    });
  });

  it('maps null and undefined to null', async () => {
    const { toAuditJson } = await import('../src/modules/villages/villages.audit.js');

    expect(toAuditJson(null)).toBeNull();
    expect(toAuditJson(undefined)).toBeNull();
  });
});

describe('villageAudit', () => {
  beforeEach(() => {
    audit.recordAudit.mockReset();
    audit.recordAudit.mockResolvedValue({});
  });

  it('calls recordAudit(input, tx) with JSON-safe snapshots on the same transaction', async () => {
    const { villageAudit } = await import('../src/modules/villages/villages.audit.js');
    const date = new Date('2026-11-01T10:00:00.000Z');

    await villageAudit.record(
      tx,
      entry({ before: null, after: { latitude: new Prisma.Decimal('31.5'), updatedAt: date } }),
    );

    expect(audit.recordAudit).toHaveBeenCalledTimes(1);
    expect(audit.recordAudit).toHaveBeenCalledWith(
      {
        entityType: 'village',
        entityId: '11111111-1111-4111-8111-111111111111',
        action: AuditAction.UPDATE,
        actorId: '22222222-2222-4222-8222-222222222222',
        before: null,
        after: { latitude: '31.5', updatedAt: '2026-11-01T10:00:00.000Z' },
        requestId: 'request-1',
      },
      tx,
    );
  });

  it('propagates audit errors so the transaction rolls back', async () => {
    const { villageAudit } = await import('../src/modules/villages/villages.audit.js');
    audit.recordAudit.mockRejectedValue(new Error('audit failed'));

    await expect(villageAudit.record(tx, entry())).rejects.toThrow('audit failed');
  });
});
