import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import { Prisma, Role, type User } from '@prisma/client';
import { env } from '../../config/env.js';
import { AppError, ForbiddenError, UnauthorizedError } from '../../shared/errors.js';
import { authRepository, type AuthRepository, type PublicUser } from './auth.repository.js';
import type { LoginInput, RefreshInput, RegisterInput } from './auth.schemas.js';

interface AccessTokenPayload extends JwtPayload {
  sub: string;
  role: Role;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult extends AuthTokens {
  user: PublicUser;
}

type RefreshTransactionResult =
  | { status: 'rotated'; tokens: AuthTokens }
  | { status: 'unauthorized' }
  | { status: 'inactive' }
  | { status: 'reused'; userId: string };

const BCRYPT_COST = 12;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isPrismaUniqueError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export class AuthService {
  constructor(private readonly repository: AuthRepository = authRepository) {}

  async register(input: RegisterInput): Promise<PublicUser> {
    const email = normalizeEmail(input.email);
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

    try {
      return await this.repository.createUser({
        email,
        passwordHash,
        fullName: input.fullName,
        role: Role.EDITOR,
      });
    } catch (err) {
      if (isPrismaUniqueError(err)) {
        throw new AppError(409, 'EMAIL_TAKEN', 'Email is already registered');
      }

      throw err;
    }
  }

  async login(input: LoginInput): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    const user = await this.repository.findUserByEmail(email);
    const validPassword = user ? await bcrypt.compare(input.password, user.passwordHash) : false;

    if (!user || !validPassword) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    if (!user.isActive) {
      throw new ForbiddenError('User account is inactive');
    }

    const tokens = await this.issueTokens(user);
    return { ...tokens, user: toPublicUser(user) };
  }

  async refresh(input: RefreshInput): Promise<AuthTokens> {
    const presentedHash = sha256(input.refreshToken);
    const newRefreshToken = randomBytes(32).toString('base64url');
    const newRefreshTokenHash = sha256(newRefreshToken);
    const expiresAt = refreshExpiresAt();

    const result = await this.repository.transaction<RefreshTransactionResult>(async (repository) => {
      const changed = await repository.revokePresentedRefreshToken(presentedHash);
      const token = await repository.findRefreshTokenByHash(presentedHash);

      if (changed !== 1) {
        if (token?.revokedAt) {
          return { status: 'reused', userId: token.userId };
        }

        return { status: 'unauthorized' };
      }

      if (!token || token.expiresAt <= new Date()) {
        return { status: 'unauthorized' };
      }

      if (!token.user.isActive) {
        return { status: 'inactive' };
      }

      await repository.createRefreshToken({
        userId: token.userId,
        tokenHash: newRefreshTokenHash,
        expiresAt,
      });

      return {
        status: 'rotated',
        tokens: {
          accessToken: signAccessToken(token.user),
          refreshToken: newRefreshToken,
        },
      };
    });

    if (result.status === 'rotated') {
      return result.tokens;
    }

    if (result.status === 'reused') {
      await this.repository.revokeAllUserRefreshTokens(result.userId);
      throw new UnauthorizedError();
    }

    if (result.status === 'inactive') {
      throw new ForbiddenError('User account is inactive');
    }

    throw new UnauthorizedError();
  }

  async logout(input: RefreshInput): Promise<void> {
    await this.repository.revokeRefreshToken(sha256(input.refreshToken));
  }

  async getMe(userId: string): Promise<PublicUser> {
    const user = await this.repository.findUserById(userId);
    if (!user) {
      throw new UnauthorizedError();
    }

    return user;
  }

  verifyAccessToken(token: string): { id: string; role: Role } {
    try {
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
      if (!payload.sub || !payload.role || !Object.values(Role).includes(payload.role)) {
        throw new UnauthorizedError();
      }

      return { id: payload.sub, role: payload.role };
    } catch {
      throw new UnauthorizedError();
    }
  }

  private async issueTokens(user: Pick<User, 'id' | 'email' | 'fullName' | 'role'>): Promise<AuthTokens> {
    const refreshToken = randomBytes(32).toString('base64url');
    await this.repository.createRefreshToken({
      userId: user.id,
      tokenHash: sha256(refreshToken),
      expiresAt: refreshExpiresAt(),
    });

    return {
      accessToken: signAccessToken(user),
      refreshToken,
    };
  }
}

function toPublicUser(user: Pick<User, 'id' | 'email' | 'fullName' | 'role'>): PublicUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
  };
}

function signAccessToken(user: Pick<User, 'id' | 'role'>): string {
  const expiresIn = env.JWT_ACCESS_TTL as SignOptions['expiresIn'];

  return jwt.sign({ role: user.role }, env.JWT_ACCESS_SECRET, {
    subject: user.id,
    expiresIn,
    algorithm: 'HS256',
  });
}

function refreshExpiresAt(): Date {
  return new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export const authService = new AuthService();
