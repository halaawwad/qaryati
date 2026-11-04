import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserService } from '../src/modules/users/users.service.js';
import type { UserDetails, UserRepository, UserTransaction } from '../src/modules/users/users.repository.js';

vi.mock('../src/shared/db.js', () => ({ prisma: {} }));

const adminId = 'admin';
const targetId = 'target';
const user: UserDetails = {
  id: targetId, email: 'user@example.test', fullName: 'Test User', role: 'EDITOR', isActive: true,
  createdAt: new Date(), updatedAt: new Date(),
};
const tx = {
  findById: vi.fn(), countActiveAdmins: vi.fn(), update: vi.fn(), revokeRefreshTokens: vi.fn(),
};
const repo: UserRepository = {
  ...tx, update: vi.fn(), revokeRefreshTokens: vi.fn(), findMany: vi.fn(),
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
      ? service.updateRole(adminId, adminId, 'EDITOR')
      : service.updateStatus(adminId, adminId, false);
    await expect(action).rejects.toMatchObject({ statusCode: 409, code: 'CANNOT_MODIFY_SELF' });
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  it.each(['role', 'status'])('allows self %s no-ops even for the last admin', async (field) => {
    const admin = { ...user, id: adminId, role: 'ADMIN' };
    tx.findById.mockResolvedValue(admin);
    tx.countActiveAdmins.mockResolvedValue(1);
    await expect(field === 'role'
      ? service.updateRole(adminId, adminId, 'ADMIN')
      : service.updateStatus(adminId, adminId, true)).resolves.toEqual(admin);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.countActiveAdmins).not.toHaveBeenCalled();
  });

  it.each(['role', 'status'])('protects the last active admin against %s changes', async (field) => {
    tx.findById.mockResolvedValue({ ...user, role: 'ADMIN' });
    tx.countActiveAdmins.mockResolvedValue(1);
    await expect(field === 'role'
      ? service.updateRole(adminId, targetId, 'REVIEWER')
      : service.updateStatus(adminId, targetId, false)).rejects.toMatchObject({ statusCode: 409, code: 'LAST_ADMIN' });
    expect(tx.update).not.toHaveBeenCalled();
  });

  it.each(['role', 'status'])('allows removing an active admin by %s when another remains', async (field) => {
    tx.findById.mockResolvedValue({ ...user, role: 'ADMIN' });
    await (field === 'role'
      ? service.updateRole(adminId, targetId, 'REVIEWER')
      : service.updateStatus(adminId, targetId, false));
    expect(tx.countActiveAdmins).toHaveBeenCalledOnce();
    expect(tx.update).toHaveBeenCalledOnce();
  });

  it('does not count an inactive admin as an active admin being removed', async () => {
    tx.findById.mockResolvedValue({ ...user, role: 'ADMIN', isActive: false });
    await service.updateRole(adminId, targetId, 'EDITOR');
    expect(tx.countActiveAdmins).not.toHaveBeenCalled();
  });

  it('updates and revokes refresh tokens through the same transaction repository', async () => {
    await expect(service.updateStatus(adminId, targetId, false)).resolves.toMatchObject({ isActive: false });
    expect(repo.transaction).toHaveBeenCalledOnce();
    expect(tx.update).toHaveBeenCalledWith(targetId, { isActive: false });
    expect(tx.revokeRefreshTokens).toHaveBeenCalledWith(targetId);
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  it.each(['role', 'status'])('allows another user same-value %s updates', async (field) => {
    await expect(field === 'role'
      ? service.updateRole(adminId, targetId, 'EDITOR')
      : service.updateStatus(adminId, targetId, true)).resolves.toEqual(user);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  it('does not revoke tokens when activating a user or changing a role', async () => {
    tx.findById.mockResolvedValue({ ...user, isActive: false });
    await service.updateStatus(adminId, targetId, true);
    await service.updateRole(adminId, targetId, 'REVIEWER');
    expect(tx.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  it.each(['get', 'role', 'status'])('returns USER_NOT_FOUND for an unknown id on %s', async (operation) => {
    tx.findById.mockResolvedValue(null);
    const action = operation === 'get' ? service.getById('missing') : operation === 'role'
      ? service.updateRole(adminId, 'missing', 'REVIEWER') : service.updateStatus(adminId, 'missing', false);
    await expect(action).rejects.toMatchObject({ statusCode: 404, code: 'USER_NOT_FOUND' });
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('retries the entire transaction after P2034, reading and checking again', async () => {
    tx.findById.mockResolvedValue({ ...user, role: 'ADMIN' });
    tx.update.mockRejectedValueOnce({ code: 'P2034' }).mockResolvedValue({ ...user, role: 'REVIEWER' });
    await expect(service.updateRole(adminId, targetId, 'REVIEWER')).resolves.toMatchObject({ role: 'REVIEWER' });
    expect(repo.transaction).toHaveBeenCalledTimes(2);
    expect(tx.findById).toHaveBeenCalledTimes(2);
    expect(tx.countActiveAdmins).toHaveBeenCalledTimes(2);
  });

  it('gives up after three total P2034 attempts', async () => {
    const conflict = { code: 'P2034' };
    tx.update.mockRejectedValue(conflict);
    await expect(service.updateRole(adminId, targetId, 'REVIEWER')).rejects.toBe(conflict);
    expect(repo.transaction).toHaveBeenCalledTimes(3);
    expect(tx.findById).toHaveBeenCalledTimes(3);
  });

  it('does not retry other transaction errors', async () => {
    const failure = new Error('database unavailable');
    tx.update.mockRejectedValue(failure);
    await expect(service.updateRole(adminId, targetId, 'REVIEWER')).rejects.toBe(failure);
    expect(repo.transaction).toHaveBeenCalledOnce();
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
