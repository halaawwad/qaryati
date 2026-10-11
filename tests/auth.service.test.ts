import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Prisma, Role } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthRepository, PublicUser, RefreshTokenWithUser, SafeUser, UserWithPassword } from '../src/modules/auth/auth.repository.js';
import type { AuthService } from '../src/modules/auth/auth.service.js';
import { AppError } from '../src/shared/errors.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function prismaUniqueError(): Error {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

class FakeAuthRepository implements AuthRepository {
  users = new Map<string, UserWithPassword>();
  tokens = new Map<string, RefreshTokenWithUser>();
  createUserError: unknown;
  revokedAllUserIds: string[] = [];
  revokedAllInsideTransaction: boolean[] = [];
  private inTransaction = false;

  async createUser(data: { email: string; passwordHash: string; fullName: string; role: Role }): Promise<PublicUser> {
    if (this.createUserError) throw this.createUserError;
    const user: UserWithPassword = {
      id: `user-${this.users.size + 1}`,
      email: data.email,
      passwordHash: data.passwordHash,
      fullName: data.fullName,
      role: data.role,
      isActive: true,
    };
    this.users.set(user.email, user);
    return toPublic(user);
  }

  async findUserByEmail(email: string): Promise<UserWithPassword | null> {
    return this.users.get(email) ?? null;
  }

  async findUserById(id: string): Promise<PublicUser | null> {
    const user = [...this.users.values()].find((item) => item.id === id);
    return user ? toPublic(user) : null;
  }

  async createRefreshToken(data: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    const user = [...this.users.values()].find((item) => item.id === data.userId);
    if (!user) throw new Error('Missing fake user');
    this.tokens.set(data.tokenHash, {
      id: `token-${this.tokens.size + 1}`,
      userId: data.userId,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
      revokedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      user: toSafe(user),
    });
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenWithUser | null> {
    return this.tokens.get(tokenHash) ?? null;
  }

  async revokePresentedRefreshToken(tokenHash: string): Promise<number> {
    const token = this.tokens.get(tokenHash);
    if (!token || token.revokedAt) return 0;
    token.revokedAt = new Date();
    return 1;
  }

  async revokeRefreshToken(tokenHash: string): Promise<void> {
    const token = this.tokens.get(tokenHash);
    if (token && !token.revokedAt) token.revokedAt = new Date();
  }

  async revokeAllUserRefreshTokens(userId: string): Promise<void> {
    this.revokedAllUserIds.push(userId);
    this.revokedAllInsideTransaction.push(this.inTransaction);
    for (const token of this.tokens.values()) {
      if (token.userId === userId && !token.revokedAt) token.revokedAt = new Date();
    }
  }

  async transaction<T>(fn: (repository: AuthRepository) => Promise<T>): Promise<T> {
    this.inTransaction = true;
    try {
      return await fn(this);
    } finally {
      this.inTransaction = false;
    }
  }
}

let Service: typeof AuthService;

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@localhost:5432/db');
  vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
  vi.stubEnv('JWT_ACCESS_SECRET', 'test-secret-with-at-least-32-characters');
  vi.stubEnv('JWT_ACCESS_TTL', '15m');
  vi.stubEnv('JWT_REFRESH_TTL_DAYS', '7');
  Service = (await import('../src/modules/auth/auth.service.js')).AuthService;
});

describe('AuthService register', () => {
  let repo: FakeAuthRepository;

  beforeEach(() => {
    repo = new FakeAuthRepository();
  });

  it('always creates EDITOR users with normalized email', async () => {
    const service = new Service(repo);
    const user = await service.register({
      email: '  USER@Example.COM ',
      password: 'password123',
      fullName: 'Test User',
    });

    expect(user).toMatchObject({ email: 'user@example.com', role: Role.EDITOR });
  });

  it('maps P2002 duplicate email races to EMAIL_TAKEN', async () => {
    repo.createUserError = prismaUniqueError();
    const service = new Service(repo);

    await expect(
      service.register({ email: 'taken@example.test', password: 'password123', fullName: 'Taken' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'EMAIL_TAKEN' });
  });
});

describe('AuthService login', () => {
  let repo: FakeAuthRepository;

  beforeEach(async () => {
    repo = new FakeAuthRepository();
    repo.users.set('user@example.test', {
      id: 'user-1',
      email: 'user@example.test',
      passwordHash: await bcrypt.hash('correct-password', 12),
      fullName: 'User One',
      role: Role.EDITOR,
      isActive: true,
    });
  });

  it('returns identical errors for wrong password and unknown email', async () => {
    const service = new Service(repo);
    const wrongPassword = service.login({ email: 'user@example.test', password: 'wrong' }).catch((err: AppError) => err);
    const unknownEmail = service.login({ email: 'unknown@example.test', password: 'wrong' }).catch((err: AppError) => err);

    await expect(wrongPassword).resolves.toMatchObject({ statusCode: 401, code: 'INVALID_CREDENTIALS' });
    await expect(unknownEmail).resolves.toMatchObject({ statusCode: 401, code: 'INVALID_CREDENTIALS' });
    await expect(wrongPassword).resolves.toMatchObject(await unknownEmail);
  });

  it('rejects inactive users', async () => {
    const user = repo.users.get('user@example.test');
    if (!user) throw new Error('Missing fake user');
    user.isActive = false;

    await expect(new Service(repo).login({ email: 'user@example.test', password: 'correct-password' })).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
  });
});

describe('AuthService refresh', () => {
  let repo: FakeAuthRepository;
  let user: UserWithPassword;

  beforeEach(async () => {
    repo = new FakeAuthRepository();
    user = {
      id: 'user-1',
      email: 'user@example.test',
      passwordHash: await bcrypt.hash('password123', 12),
      fullName: 'User One',
      role: Role.EDITOR,
      isActive: true,
    };
    repo.users.set(user.email, user);
  });

  it('rotates refresh tokens', async () => {
    const oldToken = 'old-refresh-token';
    await repo.createRefreshToken({
      userId: user.id,
      tokenHash: hashToken(oldToken),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const result = await new Service(repo).refresh({ refreshToken: oldToken });

    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).not.toBe(oldToken);
    expect(repo.tokens.get(hashToken(oldToken))?.revokedAt).toBeInstanceOf(Date);
    expect(repo.tokens.has(hashToken(result.refreshToken))).toBe(true);
  });

  it('detects reuse and revokes all user refresh tokens', async () => {
    const oldToken = 'old-refresh-token';
    await repo.createRefreshToken({
      userId: user.id,
      tokenHash: hashToken(oldToken),
      expiresAt: new Date(Date.now() + 60_000),
    });

    await new Service(repo).refresh({ refreshToken: oldToken });
    await expect(new Service(repo).refresh({ refreshToken: oldToken })).rejects.toMatchObject({ statusCode: 401 });
    expect(repo.revokedAllUserIds).toEqual([user.id]);
    expect(repo.revokedAllInsideTransaction).toEqual([false]);
  });

  it('does not rotate the same token twice', async () => {
    const oldToken = 'single-use-token';
    await repo.createRefreshToken({
      userId: user.id,
      tokenHash: hashToken(oldToken),
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(new Service(repo).refresh({ refreshToken: oldToken })).resolves.toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    });
    await expect(new Service(repo).refresh({ refreshToken: oldToken })).rejects.toMatchObject({ statusCode: 401 });
  });
});

function toPublic(user: UserWithPassword): PublicUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
  };
}

function toSafe(user: UserWithPassword): SafeUser {
  return {
    ...toPublic(user),
    isActive: user.isActive,
  };
}
