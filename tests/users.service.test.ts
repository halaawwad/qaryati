import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserService } from '../src/modules/users/users.service.js';
import type { UserDetails, UserRepository, UserTransaction } from '../src/modules/users/users.repository.js';

vi.mock('../src/shared/db.js', () => ({ prisma: {} }));

const adminId = 'admin';
const context = { actorId: adminId, requestId: 'req-1' };
const targetId = 'target';
const user: UserDetails = {
  id: targetId, email: 'user@example.test', fullName: 'Test User', role: 'EDITOR', isActive: true,
  createdAt: new Date(), updatedAt: new Date(),
};
const tx = {
  findById: vi.fn(), countActiveAdmins: vi.fn(), update: vi.fn(), revokeRefreshTokens: vi.fn(), recordAudit: vi.fn(),
};
const repo: UserRepository = {
  ...tx, update: vi.fn(), revokeRefreshTokens: vi.fn(), recordAudit: vi.fn(), findMany: vi.fn(),
  transaction: vi.fn(async (fn: (repository: UserTransaction) => Promise<unknown>) => fn(tx)) as UserRepository['transaction'],
};
const service = new UserService(repo);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(repo.transaction).mockImplementation(async (fn) => fn(tx));
  tx.findById.mockResolvedValue({ ...user });
  tx.countActiveAdmins.mockResolvedValue(2);
  tx.update.mockImplementation(async (id, change) => ({ ...user, id, ...change }));
});

describe('UserService updates', () => {
  it.each(['role', 'status'])('blocks actual self %s changes', async (field) => {
    tx.findById.mockResolvedValue({ ...user, id: adminId, role: 'ADMIN' });
    const action = field === 'role'
      ? service.updateRole(context, adminId, 'EDITOR')
      : service.updateStatus(context, adminId, false);
    await expect(action).rejects.toMatchObject({ statusCode: 409, code: 'CANNOT_MODIFY_SELF' });
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  it.each(['role', 'status'])('allows self %s no-ops even for the last admin', async (field) => {
    const admin = { ...user, id: adminId, role: 'ADMIN' };
    tx.findById.mockResolvedValue(admin);
    tx.countActiveAdmins.mockResolvedValue(1);
    await expect(field === 'role'
      ? service.updateRole(context, adminId, 'ADMIN')
      : service.updateStatus(context, adminId, true)).resolves.toEqual(admin);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.countActiveAdmins).not.toHaveBeenCalled();
  });

  it.each(['role', 'status'])('protects the last active admin against %s changes', async (field) => {
    tx.findById.mockResolvedValue({ ...user, role: 'ADMIN' });
    tx.countActiveAdmins.mockResolvedValue(1);
    await expect(field === 'role'
      ? service.updateRole(context, targetId, 'REVIEWER')
      : service.updateStatus(context, targetId, false)).rejects.toMatchObject({ statusCode: 409, code: 'LAST_ADMIN' });
    expect(tx.update).not.toHaveBeenCalled();
  });

  it.each(['role', 'status'])('allows removing an active admin by %s when another remains', async (field) => {
    tx.findById.mockResolvedValue({ ...user, role: 'ADMIN' });
    await (field === 'role'
      ? service.updateRole(context, targetId, 'REVIEWER')
      : service.updateStatus(context, targetId, false));
    expect(tx.countActiveAdmins).toHaveBeenCalledOnce();
    expect(tx.update).toHaveBeenCalledOnce();
  });

  it('does not count an inactive admin as an active admin being removed', async () => {
    tx.findById.mockResolvedValue({ ...user, role: 'ADMIN', isActive: false });
    await service.updateRole(context, targetId, 'EDITOR');
    expect(tx.countActiveAdmins).not.toHaveBeenCalled();
  });

  it('updates and revokes refresh tokens through the same transaction repository', async () => {
    await expect(service.updateStatus(context, targetId, false)).resolves.toMatchObject({ isActive: false });
    expect(repo.transaction).toHaveBeenCalledOnce();
    expect(tx.update).toHaveBeenCalledWith(targetId, { isActive: false });
    expect(tx.revokeRefreshTokens).toHaveBeenCalledWith(targetId);
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  it.each(['role', 'status'])('allows another user same-value %s updates', async (field) => {
    await expect(field === 'role'
      ? service.updateRole(context, targetId, 'EDITOR')
      : service.updateStatus(context, targetId, true)).resolves.toEqual(user);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  it('does not revoke tokens when activating a user or changing a role', async () => {
    tx.findById.mockResolvedValue({ ...user, isActive: false });
    await service.updateStatus(context, targetId, true);
    await service.updateRole(context, targetId, 'REVIEWER');
    expect(tx.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  it.each(['get', 'role', 'status'])('returns USER_NOT_FOUND for an unknown id on %s', async (operation) => {
    tx.findById.mockResolvedValue(null);
    const action = operation === 'get' ? service.getById('missing') : operation === 'role'
      ? service.updateRole(context, 'missing', 'REVIEWER') : service.updateStatus(context, 'missing', false);
    await expect(action).rejects.toMatchObject({ statusCode: 404, code: 'USER_NOT_FOUND' });
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('retries the entire transaction after P2034, reading and checking again', async () => {
    tx.findById.mockResolvedValue({ ...user, role: 'ADMIN' });
    tx.update.mockRejectedValueOnce({ code: 'P2034' }).mockResolvedValue({ ...user, role: 'REVIEWER' });
    await expect(service.updateRole(context, targetId, 'REVIEWER')).resolves.toMatchObject({ role: 'REVIEWER' });
    expect(repo.transaction).toHaveBeenCalledTimes(2);
    expect(tx.findById).toHaveBeenCalledTimes(2);
    expect(tx.countActiveAdmins).toHaveBeenCalledTimes(2);
  });

  it('gives up after three total P2034 attempts', async () => {
    const conflict = { code: 'P2034' };
    tx.update.mockRejectedValue(conflict);
    await expect(service.updateRole(context, targetId, 'REVIEWER')).rejects.toBe(conflict);
    expect(repo.transaction).toHaveBeenCalledTimes(3);
    expect(tx.findById).toHaveBeenCalledTimes(3);
  });

  it('does not retry other transaction errors', async () => {
    const failure = new Error('database unavailable');
    tx.update.mockRejectedValue(failure);
    await expect(service.updateRole(context, targetId, 'REVIEWER')).rejects.toBe(failure);
    expect(repo.transaction).toHaveBeenCalledOnce();
  });
});

describe('UserService audit', () => {
  it.each([
    { field: 'role', run: () => service.updateRole(context, targetId, 'REVIEWER'), before: { role: 'EDITOR' }, after: { role: 'REVIEWER' } },
    { field: 'status', run: () => service.updateStatus(context, targetId, false), before: { isActive: true }, after: { isActive: false } },
  ])('records exactly one audit row with only the changed field for a $field change', async ({ run, before, after }) => {
    await run();
    expect(tx.recordAudit).toHaveBeenCalledOnce();
    expect(tx.recordAudit).toHaveBeenCalledWith({
      entityType: 'User', entityId: targetId, action: 'UPDATE', actorId: adminId, requestId: 'req-1', before, after,
    });
  });

  it('writes the audit through the same transaction repository as the update', async () => {
    await service.updateRole(context, targetId, 'REVIEWER');
    expect(repo.transaction).toHaveBeenCalledOnce();
    expect(tx.update).toHaveBeenCalledOnce();
    expect(tx.recordAudit).toHaveBeenCalledOnce();
    expect(tx.update.mock.invocationCallOrder[0]).toBeLessThan(tx.recordAudit.mock.invocationCallOrder[0]!);
    expect(repo.recordAudit).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'role no-op', run: () => service.updateRole(context, targetId, 'EDITOR') },
    { name: 'status no-op', run: () => service.updateStatus(context, targetId, true) },
    { name: 'self role CANNOT_MODIFY_SELF', self: true, run: () => service.updateRole(context, adminId, 'EDITOR') },
    { name: 'self status CANNOT_MODIFY_SELF', self: true, run: () => service.updateStatus(context, adminId, false) },
    { name: 'role LAST_ADMIN', lastAdmin: true, run: () => service.updateRole(context, targetId, 'REVIEWER') },
    { name: 'status LAST_ADMIN', lastAdmin: true, run: () => service.updateStatus(context, targetId, false) },
    { name: 'role USER_NOT_FOUND', missing: true, run: () => service.updateRole(context, 'missing', 'REVIEWER') },
    { name: 'status USER_NOT_FOUND', missing: true, run: () => service.updateStatus(context, 'missing', false) },
  ])('records no audit row for $name', async ({ self, lastAdmin, missing, run }) => {
    if (self) tx.findById.mockResolvedValue({ ...user, id: adminId, role: 'ADMIN' });
    if (lastAdmin) {
      tx.findById.mockResolvedValue({ ...user, role: 'ADMIN' });
      tx.countActiveAdmins.mockResolvedValue(1);
    }
    if (missing) tx.findById.mockResolvedValue(null);
    await run().catch(() => undefined);
    expect(tx.recordAudit).not.toHaveBeenCalled();
    expect(repo.recordAudit).not.toHaveBeenCalled();
  });

  it('propagates audit failures without retrying so the update is not committed', async () => {
    const failure = new Error('audit insert failed');
    tx.recordAudit.mockRejectedValue(failure);
    await expect(service.updateRole(context, targetId, 'REVIEWER')).rejects.toBe(failure);
    expect(repo.transaction).toHaveBeenCalledOnce();
  });

  it('records a single audit row when a P2034 conflict retries the transaction', async () => {
    tx.update.mockRejectedValueOnce({ code: 'P2034' });
    await service.updateRole(context, targetId, 'REVIEWER');
    expect(repo.transaction).toHaveBeenCalledTimes(2);
    expect(tx.recordAudit).toHaveBeenCalledOnce();
  });

  it('retries a P2034 raised by the audit write inside the transaction', async () => {
    tx.recordAudit.mockRejectedValueOnce({ code: 'P2034' });
    await expect(service.updateStatus(context, targetId, false)).resolves.toMatchObject({ isActive: false });
    expect(repo.transaction).toHaveBeenCalledTimes(2);
    expect(tx.recordAudit).toHaveBeenCalledTimes(2);
  });
});

describe('UserService list', () => {
  it('uses default sort and existing pagination defaults', async () => {
    vi.mocked(repo.findMany).mockResolvedValue({ items: [user], total: 1 });
    await expect(service.list({})).resolves.toMatchObject({ items: [user], meta: { page: 1, limit: 20, total: 1 } });
    expect(repo.findMany).toHaveBeenCalledWith({
      filters: {}, sort: { field: 'createdAt', order: 'desc' }, skip: 0, take: 20,
    });
  });

  it('forwards filters and sort and caps the page size', async () => {
    vi.mocked(repo.findMany).mockResolvedValue({ items: [], total: 0 });
    await service.list({ page: 2, limit: 200, role: 'ADMIN', isActive: false, q: 'Name', sort: 'email', order: 'asc' });
    expect(repo.findMany).toHaveBeenCalledWith({
      filters: { role: 'ADMIN', isActive: false, q: 'Name' }, sort: { field: 'email', order: 'asc' }, skip: 100, take: 100,
    });
  });
});
