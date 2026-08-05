import { Inject, Injectable } from '@nestjs/common';
import { TransactionRunner } from '../../../shared/database/transaction-runner';
import {
  AUTH_REPOSITORY,
  AUTH_SECRET_SERVICE,
  type AuthRepository,
  type AuthSecretService,
} from './auth.ports';

@Injectable()
export class LogoutUser {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
    @Inject(AUTH_SECRET_SERVICE) private readonly secrets: AuthSecretService,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(refreshToken: string | undefined): Promise<void> {
    if (refreshToken === undefined) {
      return;
    }
    await this.transactions.run((context) =>
      this.repository.revokeRefreshSessionFamily(
        context,
        this.secrets.hash(refreshToken),
        new Date(),
      ),
    );
  }
}
