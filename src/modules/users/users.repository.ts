import { Prisma, type User } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import type { ListUsersQuery, UserRole } from './users.schemas.js';

export type UserDetails = Pick<User, 'id' | 'email' | 'fullName' | 'role' | 'isActive' | 'createdAt' | 'updatedAt'>;
export type UserChange = { role: UserRole } | { isActive: boolean };
export interface UserListParams {
  filters: Pick<ListUsersQuery, 'role' | 'isActive' | 'q'>;
  sort: { field: NonNullable<ListUsersQuery['sort']>; order: 'asc' | 'desc' };
  skip: number;
  take: number;
}
export interface UserTransaction {
  findById(id: string): Promise<UserDetails | null>;
  countActiveAdmins(): Promise<number>;
  update(id: string, change: UserChange): Promise<UserDetails>;
  revokeRefreshTokens(userId: string): Promise<void>;
}
export interface UserRepository extends UserTransaction {
  findMany(params: UserListParams): Promise<{ items: UserDetails[]; total: number }>;
  transaction<T>(fn: (repository: UserTransaction) => Promise<T>): Promise<T>;
}

const userSelect = {
  id: true, email: true, fullName: true, role: true, isActive: true, createdAt: true, updatedAt: true,
} satisfies Prisma.UserSelect;

function transactionRepository(client: Prisma.TransactionClient): UserTransaction {
  return {
    findById(id) {
      return client.user.findUnique({ where: { id }, select: userSelect });
    },
    countActiveAdmins() {
      return client.user.count({ where: { role: 'ADMIN', isActive: true } });
    },
    update(id, change) {
      return client.user.update({ where: { id }, data: change, select: userSelect });
    },
    async revokeRefreshTokens(userId) {
      await client.refreshToken.updateMany({
        where: { userId, revokedAt: null }, data: { revokedAt: new Date() },
      });
    },
  };
}

export const userRepository: UserRepository = {
  ...transactionRepository(prisma),
  async findMany({ filters, sort, skip, take }) {
    const where: Prisma.UserWhereInput = { role: filters.role, isActive: filters.isActive };
    if (filters.q) {
      const contains = { contains: filters.q.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' } as const;
      where.OR = [{ email: contains }, { fullName: contains }];
    }
    return prisma.$transaction(async (tx) => {
      const [total, items] = await Promise.all([
        tx.user.count({ where }),
        tx.user.findMany({ where, select: userSelect, skip, take, orderBy: [{ [sort.field]: sort.order }, { id: 'asc' }] }),
      ]);
      return { items, total };
    });
  },
  transaction(fn) {
    return prisma.$transaction((tx) => fn(transactionRepository(tx)), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  },
};
