import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { TransactionRunner } from '../../../shared/database/transaction-runner';
import { AuthApplicationError } from './auth-errors';
import {
  ACCESS_TOKEN_SERVICE,
  AUTH_REPOSITORY,
  AUTH_SECRET_SERVICE,
  type AccessTokenService,
  type AuthRepository,
  type AuthSecretService,
} from './auth.ports';
import type { AuthSessionResult } from './auth-results';

const refreshLifetimeMilliseconds = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class RefreshAuthSession {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
    @Inject(AUTH_SECRET_SERVICE) private readonly secrets: AuthSecretService,
    @Inject(ACCESS_TOKEN_SERVICE)
    private readonly accessTokens: AccessTokenService,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(currentToken: string): Promise<AuthSessionResult> {
    const replacementToken = this.secrets.generate();
    const result = await this.transactions.run((context) =>
      this.repository.rotateRefreshSession(
        context,
        this.secrets.hash(currentToken),
        {
          id: randomUUID(),
          tokenHash: this.secrets.hash(replacementToken),
          expiresAt: new Date(Date.now() + refreshLifetimeMilliseconds),
        },
        new Date(),
      ),
    );
    if (result.kind !== 'rotated') {
      throw new AuthApplicationError('SESSION_INVALID');
    }
    return {
      accessToken: this.accessTokens.sign(result.principal),
      refreshToken: replacementToken,
    };
  }
}
