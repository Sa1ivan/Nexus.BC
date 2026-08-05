import { Inject, Injectable } from '@nestjs/common';
import { PrismaClientService } from '../../../shared/database/prisma.service';
import type { TransactionContext } from '../../../shared/database/transaction-runner';
import {
  PrismaTransactionClientService,
  TransactionRunner,
} from '../../../shared/database/transaction-runner';
import { AuthApplicationError } from '../application/auth-errors';
import type {
  AuthRepository,
  AuthUserRecord,
  PasswordResetWrite,
  RefreshReplacement,
  RefreshRotationResult,
  RefreshSessionWrite,
  RegistrationWrite,
} from '../application/auth.ports';

interface UserRow {
  readonly email: string;
  readonly emailVerifiedAt: Date | null;
  readonly id: string;
  readonly passwordHash: string;
}

interface RefreshRow extends UserRow {
  readonly expiresAt: Date;
  readonly familyId: string;
  readonly refreshSessionId: string;
  readonly revokedAt: Date | null;
  readonly rotatedAt: Date | null;
  readonly userId: string;
}

interface TokenRow {
  readonly consumedAt: Date | null;
  readonly expiresAt: Date;
  readonly id: string;
  readonly userId: string;
}

interface CredentialStateRow {
  readonly emailVerifiedAt: Date | null;
  readonly passwordHash: string;
}

interface RefreshFamilyRow {
  readonly familyId: string;
}

interface AuthPrismaClient {
  readonly user: {
    findUnique(arguments_: {
      readonly where: { readonly email: string };
      readonly select: Readonly<Record<string, boolean>>;
    }): Promise<UserRow | null>;
  };
}

interface AuthTransactionClient {
  $executeRawUnsafe(
    statement: string,
    ...values: readonly unknown[]
  ): Promise<number>;
  $queryRawUnsafe<T>(
    statement: string,
    ...values: readonly unknown[]
  ): Promise<T>;
  readonly emailVerificationToken: {
    create(arguments_: {
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<unknown>;
  };
  readonly passwordResetToken: {
    create(arguments_: {
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<unknown>;
  };
  readonly refreshSession: {
    create(arguments_: {
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<unknown>;
    update(arguments_: {
      readonly where: { readonly id: string };
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<unknown>;
    updateMany(arguments_: {
      readonly where: Readonly<Record<string, unknown>>;
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<{ readonly count: number }>;
  };
  readonly user: {
    create(arguments_: {
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<unknown>;
    update(arguments_: {
      readonly where: { readonly id: string };
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<unknown>;
  };
}

function isUniqueConstraintFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return error.code === 'P2002' || error.code === '23505';
}

@Injectable()
export class PrismaAuthRepository implements AuthRepository {
  constructor(
    @Inject(PrismaClientService)
    private readonly prisma: AuthPrismaClient,
    private readonly transactions: TransactionRunner,
  ) {}

  async findUserByEmail(email: string): Promise<AuthUserRecord | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        emailVerifiedAt: true,
      },
    });
    return user === null
      ? null
      : {
          userId: user.id,
          email: user.email,
          passwordHash: user.passwordHash,
          emailVerifiedAt: user.emailVerifiedAt,
        };
  }

  async createRegistration(
    context: TransactionContext,
    write: RegistrationWrite,
  ): Promise<void> {
    try {
      await this.withTransaction(context, async (transaction) => {
        await transaction.user.create({
          data: {
            id: write.userId,
            email: write.email,
            passwordHash: write.passwordHash,
          },
        });
        await transaction.emailVerificationToken.create({
          data: {
            id: write.token.id,
            userId: write.userId,
            tokenHash: write.token.tokenHash,
            expiresAt: write.token.expiresAt,
          },
        });
      });
    } catch (error) {
      if (isUniqueConstraintFailure(error)) {
        throw new AuthApplicationError('EMAIL_ALREADY_REGISTERED');
      }
      throw error;
    }
  }

  async consumeEmailVerification(
    context: TransactionContext,
    tokenHash: string,
    now: Date,
  ): Promise<boolean> {
    return this.withTransaction(context, async (transaction) => {
      const rows = await transaction.$queryRawUnsafe<TokenRow[]>(
        `SELECT "id", "userId", "expiresAt", "consumedAt"
           FROM "EmailVerificationToken"
          WHERE "tokenHash" = $1
          FOR UPDATE`,
        tokenHash,
      );
      const token = rows[0];
      if (
        token === undefined ||
        token.consumedAt !== null ||
        token.expiresAt.getTime() <= now.getTime()
      ) {
        return false;
      }
      await transaction.$executeRawUnsafe(
        `UPDATE "EmailVerificationToken"
            SET "consumedAt" = $2
          WHERE "id" = $1::uuid`,
        token.id,
        now,
      );
      await transaction.user.update({
        where: { id: token.userId },
        data: { emailVerifiedAt: now },
      });
      return true;
    });
  }

  async createRefreshSession(
    context: TransactionContext,
    write: RefreshSessionWrite,
    expectedPasswordHash: string,
  ): Promise<boolean> {
    return this.withTransaction(context, async (transaction) => {
      const rows = await transaction.$queryRawUnsafe<CredentialStateRow[]>(
        `SELECT "passwordHash", "emailVerifiedAt"
           FROM "User"
          WHERE "id" = $1::uuid
          FOR UPDATE`,
        write.userId,
      );
      const credentials = rows[0];
      if (
        credentials === undefined ||
        credentials.emailVerifiedAt === null ||
        credentials.passwordHash !== expectedPasswordHash
      ) {
        return false;
      }
      await transaction.refreshSession.create({
        data: {
          id: write.id,
          userId: write.userId,
          familyId: write.familyId,
          tokenHash: write.tokenHash,
          expiresAt: write.expiresAt,
        },
      });
      return true;
    });
  }

  async rotateRefreshSession(
    context: TransactionContext,
    currentTokenHash: string,
    replacement: RefreshReplacement,
    now: Date,
  ): Promise<RefreshRotationResult> {
    return this.withTransaction(context, async (transaction) => {
      const rows = await transaction.$queryRawUnsafe<RefreshRow[]>(
        `SELECT s."id" AS "refreshSessionId", s."userId", s."familyId",
                s."expiresAt", s."rotatedAt", s."revokedAt",
                u."id", u."email", u."passwordHash", u."emailVerifiedAt"
           FROM "RefreshSession" s
           JOIN "User" u ON u."id" = s."userId"
          WHERE s."tokenHash" = $1
          FOR UPDATE OF s`,
        currentTokenHash,
      );
      const current = rows[0];
      if (current === undefined) {
        return { kind: 'invalid' };
      }
      if (current.rotatedAt !== null) {
        await transaction.refreshSession.updateMany({
          where: { familyId: current.familyId },
          data: { revokedAt: now },
        });
        return { kind: 'reused' };
      }
      if (
        current.revokedAt !== null ||
        current.expiresAt.getTime() <= now.getTime() ||
        current.emailVerifiedAt === null
      ) {
        return { kind: 'invalid' };
      }

      await transaction.refreshSession.update({
        where: { id: current.refreshSessionId },
        data: { rotatedAt: now },
      });
      await transaction.refreshSession.create({
        data: {
          id: replacement.id,
          userId: current.userId,
          familyId: current.familyId,
          tokenHash: replacement.tokenHash,
          expiresAt: replacement.expiresAt,
        },
      });
      return {
        kind: 'rotated',
        principal: { userId: current.userId, email: current.email },
      };
    });
  }

  async revokeRefreshSessionFamily(
    context: TransactionContext,
    tokenHash: string,
    now: Date,
  ): Promise<void> {
    await this.withTransaction(context, async (transaction) => {
      const rows = await transaction.$queryRawUnsafe<RefreshFamilyRow[]>(
        `SELECT "familyId"
           FROM "RefreshSession"
          WHERE "tokenHash" = $1
          FOR UPDATE`,
        tokenHash,
      );
      const session = rows[0];
      if (session === undefined) {
        return;
      }
      await transaction.refreshSession.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: { revokedAt: now },
      });
    });
  }

  async createPasswordReset(
    context: TransactionContext,
    write: PasswordResetWrite,
  ): Promise<void> {
    await this.withTransaction(context, async (transaction) => {
      await transaction.passwordResetToken.create({
        data: {
          id: write.id,
          userId: write.userId,
          tokenHash: write.tokenHash,
          expiresAt: write.expiresAt,
        },
      });
    });
  }

  async consumePasswordReset(
    context: TransactionContext,
    tokenHash: string,
    passwordHash: string,
    now: Date,
  ): Promise<boolean> {
    return this.withTransaction(context, async (transaction) => {
      const rows = await transaction.$queryRawUnsafe<TokenRow[]>(
        `SELECT "id", "userId", "expiresAt", "consumedAt"
           FROM "PasswordResetToken"
          WHERE "tokenHash" = $1
          FOR UPDATE`,
        tokenHash,
      );
      const token = rows[0];
      if (
        token === undefined ||
        token.consumedAt !== null ||
        token.expiresAt.getTime() <= now.getTime()
      ) {
        return false;
      }
      await transaction.$executeRawUnsafe(
        `UPDATE "PasswordResetToken"
            SET "consumedAt" = $2
          WHERE "id" = $1::uuid`,
        token.id,
        now,
      );
      await transaction.user.update({
        where: { id: token.userId },
        data: { passwordHash },
      });
      await transaction.refreshSession.updateMany({
        where: { userId: token.userId, revokedAt: null },
        data: { revokedAt: now },
      });
      return true;
    });
  }

  private async withTransaction<T>(
    context: TransactionContext,
    work: (transaction: AuthTransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.transactions[PrismaTransactionClientService](
      context,
      (client) => work(client as AuthTransactionClient),
    );
  }
}
