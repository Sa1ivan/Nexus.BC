import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { TransactionRunner } from '../../../shared/database/transaction-runner';
import { AuthApplicationError } from './auth-errors';
import {
  ACCESS_TOKEN_SERVICE,
  AUTH_REPOSITORY,
  AUTH_SECRET_SERVICE,
  PASSWORD_HASHER,
  type AccessTokenService,
  type AuthRepository,
  type AuthSecretService,
  type PasswordHasher,
} from './auth.ports';
import type { AuthSessionResult } from './auth-results';

const refreshLifetimeMilliseconds = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class LoginUser {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
    @Inject(AUTH_SECRET_SERVICE) private readonly secrets: AuthSecretService,
    @Inject(ACCESS_TOKEN_SERVICE)
    private readonly accessTokens: AccessTokenService,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(email: string, password: string): Promise<AuthSessionResult> {
    const user = await this.repository.findUserByEmail(email);
    if (user === null) {
      await this.passwords.spendFailureBudget(password);
      throw new AuthApplicationError('INVALID_CREDENTIALS');
    }
    if (!(await this.passwords.verify(user.passwordHash, password))) {
      throw new AuthApplicationError('INVALID_CREDENTIALS');
    }
    if (user.emailVerifiedAt === null) {
      throw new AuthApplicationError('EMAIL_NOT_VERIFIED');
    }

    const refreshToken = this.secrets.generate();
    const sessionCreated = await this.transactions.run((context) =>
      this.repository.createRefreshSession(
        context,
        {
          id: randomUUID(),
          userId: user.userId,
          familyId: randomUUID(),
          tokenHash: this.secrets.hash(refreshToken),
          expiresAt: new Date(Date.now() + refreshLifetimeMilliseconds),
        },
        user.passwordHash,
      ),
    );
    if (!sessionCreated) {
      throw new AuthApplicationError('INVALID_CREDENTIALS');
    }
    return {
      accessToken: this.accessTokens.sign(user),
      refreshToken,
    };
  }
}
