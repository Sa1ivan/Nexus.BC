import { Inject, Injectable } from '@nestjs/common';
import { TransactionRunner } from '../../../shared/database/transaction-runner';
import { AuthApplicationError } from './auth-errors';
import {
  AUTH_REPOSITORY,
  AUTH_SECRET_SERVICE,
  type AuthRepository,
  type AuthSecretService,
} from './auth.ports';

@Injectable()
export class VerifyEmail {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
    @Inject(AUTH_SECRET_SERVICE) private readonly secrets: AuthSecretService,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(rawToken: string): Promise<void> {
    const consumed = await this.transactions.run((context) =>
      this.repository.consumeEmailVerification(
        context,
        this.secrets.hash(rawToken),
        new Date(),
      ),
    );
    if (!consumed) {
      throw new AuthApplicationError('VERIFICATION_TOKEN_INVALID');
    }
  }
}
