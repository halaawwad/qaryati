import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userRepository } from '../src/modules/users/users.repository.js';

const audit = vi.hoisted(() => ({ recordAudit: vi.fn() }));
vi.mock('../src/modules/audit/audit.service.js', () => audit);

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn() },
  refreshToken: { updateMany: vi.fn() },
  transaction: vi.fn(),
}));
vi.mock('../src/shared/db.js', () => ({ prisma: { ...db, $transaction: db.transaction } }));
const select = { id: true, email: true, fullName: true, role: true, isActive: true, createdAt: true, updatedAt: true };

beforeEach(() => {
  vi.resetAllMocks();
  db.transaction.mockImplementation(async (fn) => fn(db));
  db.user.count.mockResolvedValue(0);
  db.user.findMany.mockResolvedValue([]);
});

describe('userRepository', () => {
  it('uses matching case-insensitive literal search and role/status filters for list and count', async () => {
    const result = await userRepository.findMany({
      filters: { role: 'ADMIN', isActive: false, q: 'A%_\\' },
      sort: { field: 'email', order: 'asc' }, skip: 5, take: 5,
    });
    const contains = { contains: 'A\\%\\_\\\\', mode: 'insensitive' };
    const where = { role: 'ADMIN', isActive: false, OR: [{ email: contains }, { fullName: contains }] };
    expect(db.user.count).toHaveBeenCalledWith({ where });
    expect(db.user.findMany).toHaveBeenCalledWith({
      where, select, skip: 5, take: 5, orderBy: [{ email: 'asc' }, { id: 'asc' }],
    });
    expect(result).toEqual({ items: [], total: 0 });
  });

  it('runs reads, active admin count, update, token revocation and audit on the Serializable transaction client', async () => {
    const auditInput = {
      entityType: 'User', entityId: 'target', action: 'UPDATE', actorId: 'admin', requestId: 'req-1',
      before: { isActive: true }, after: { isActive: false },
    } as const;
    await userRepository.transaction(async (tx) => {
      await tx.findById('target');
      await tx.countActiveAdmins();
      await tx.update('target', { isActive: false });
      await tx.revokeRefreshTokens('target');
      await tx.recordAudit(auditInput);
    });
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { id: 'target' }, select });
    expect(db.user.count).toHaveBeenCalledWith({ where: { role: 'ADMIN', isActive: true } });
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: 'target' }, data: { isActive: false }, select });
    expect(db.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'target', revokedAt: null }, data: { revokedAt: expect.any(Date) },
    });
    expect(audit.recordAudit).toHaveBeenCalledWith(auditInput, db);
  });

  it('propagates audit write failures out of the transaction', async () => {
    const failure = new Error('audit insert failed');
    audit.recordAudit.mockRejectedValue(failure);
    await expect(userRepository.transaction(async (tx) => {
      await tx.update('target', { role: 'REVIEWER' });
      await tx.recordAudit({ entityType: 'User', entityId: 'target', action: 'UPDATE' });
    })).rejects.toBe(failure);
  });
});
