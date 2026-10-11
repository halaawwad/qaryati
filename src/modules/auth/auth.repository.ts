import type { Prisma, RefreshToken, Role, User } from '@prisma/client';
import { prisma } from '../../shared/db.js';

export type SafeUser = Pick<User, 'id' | 'email' | 'fullName' | 'role' | 'isActive'>;
export type PublicUser = Pick<User, 'id' | 'email' | 'fullName' | 'role'>;
export type UserWithPassword = Pick<User, 'id' | 'email' | 'passwordHash' | 'fullName' | 'role' | 'isActive'>;
export type RefreshTokenWithUser = RefreshToken & { user: SafeUser };

export interface AuthRepository {
  createUser(data: { email: string; passwordHash: string; fullName: string; role: Role }): Promise<PublicUser>;
  findUserByEmail(email: string): Promise<UserWithPassword | null>;
  findUserById(id: string): Promise<PublicUser | null>;
  createRefreshToken(data: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void>;
  findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenWithUser | null>;
  revokePresentedRefreshToken(tokenHash: string): Promise<number>;
  revokeRefreshToken(tokenHash: string): Promise<void>;
  revokeAllUserRefreshTokens(userId: string): Promise<void>;
  transaction<T>(fn: (repository: AuthRepository) => Promise<T>): Promise<T>;
}

function publicUserSelect() {
  return {
    id: true,
    email: true,
    fullName: true,
    role: true,
  } satisfies Prisma.UserSelect;
}

function userWithPasswordSelect() {
  return {
    id: true,
    email: true,
    passwordHash: true,
    fullName: true,
    role: true,
    isActive: true,
  } satisfies Prisma.UserSelect;
}

function refreshIncludeUser() {
  return {
    user: {
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
      },
    },
  } satisfies Prisma.RefreshTokenInclude;
}

function buildRepository(client: Prisma.TransactionClient): AuthRepository {
  return {
    createUser(data) {
      return client.user.create({
        data,
        select: publicUserSelect(),
      });
    },

    findUserByEmail(email) {
      return client.user.findUnique({
        where: { email },
        select: userWithPasswordSelect(),
      });
    },

    findUserById(id) {
      return client.user.findUnique({
        where: { id },
        select: publicUserSelect(),
      });
    },

    async createRefreshToken(data) {
      await client.refreshToken.create({ data });
    },

    findRefreshTokenByHash(tokenHash) {
      return client.refreshToken.findUnique({
        where: { tokenHash },
        include: refreshIncludeUser(),
      });
    },

    async revokePresentedRefreshToken(tokenHash) {
      const result = await client.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      return result.count;
    },

    async revokeRefreshToken(tokenHash) {
      await client.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    },

    async revokeAllUserRefreshTokens(userId) {
      await client.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    },

    transaction(fn) {
      return fn(buildRepository(client));
    },
  };
}

export const authRepository: AuthRepository = {
  ...buildRepository(prisma),

  transaction(fn) {
    return prisma.$transaction((tx) => fn(buildRepository(tx)));
  },
};
