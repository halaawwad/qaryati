import { AppError } from '../../shared/errors.js';
import { buildPaginationMeta, parsePagination } from '../../shared/pagination.js';
import { userRepository, type UserChange, type UserRepository } from './users.repository.js';
import type { ListUsersQuery, UserRole } from './users.schemas.js';

function userNotFound(): AppError {
  return new AppError(404, 'USER_NOT_FOUND', 'User not found');
}

export class UserService {
  constructor(private readonly repository: UserRepository = userRepository) {}

  async list(query: ListUsersQuery) {
    const pagination = parsePagination(query);
    const result = await this.repository.findMany({
      filters: { role: query.role, isActive: query.isActive, q: query.q },
      sort: { field: query.sort ?? 'createdAt', order: query.order ?? 'desc' },
      skip: pagination.skip, take: pagination.take,
    });
    return { items: result.items, meta: buildPaginationMeta(result.total, pagination) };
  }

  async getById(id: string) {
    const user = await this.repository.findById(id);
    if (!user) throw userNotFound();
    return user;
  }

  updateRole(actorId: string, id: string, role: UserRole) {
    return this.change(actorId, id, { role });
  }

  updateStatus(actorId: string, id: string, isActive: boolean) {
    return this.change(actorId, id, { isActive });
  }

  private async change(actorId: string, id: string, change: UserChange) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.repository.transaction(async (repository) => {
          const user = await repository.findById(id);
          if (!user) throw userNotFound();
          const sameValue = 'role' in change ? user.role === change.role : user.isActive === change.isActive;
          if (sameValue) return user;
          if (actorId === id && ('role' in change || !change.isActive)) {
            throw new AppError(409, 'CANNOT_MODIFY_SELF', 'Cannot change your own role or deactivate yourself');
          }
          const removesActiveAdmin = user.role === 'ADMIN' && user.isActive
            && ('role' in change ? change.role !== 'ADMIN' : !change.isActive);
          if (removesActiveAdmin && await repository.countActiveAdmins() <= 1) {
            throw new AppError(409, 'LAST_ADMIN', 'At least one active admin must remain');
          }
          const updated = await repository.update(id, change);
          if ('isActive' in change && !change.isActive) await repository.revokeRefreshTokens(id);
          // TODO(audit): Call recordAudit for role/status changes in this transaction when src/modules/audit exports it.
          return updated;
        });
      } catch (err) {
        if (attempt >= 3 || typeof err !== 'object' || err === null || !('code' in err) || err.code !== 'P2034') throw err;
      }
    }
  }
}

export const userService = new UserService();
