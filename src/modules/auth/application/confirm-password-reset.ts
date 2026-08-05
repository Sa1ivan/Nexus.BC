import { Inject, Injectable } from '@nestjs/common';
import { TransactionRunner } from '../../../shared/database/transaction-runner';
import { AuthApplicationError } from './auth-errors';
import {
  AUTH_REPOSITORY,
  AUTH_SECRET_SERVICE,
  PASSWORD_HASHER,
  type AuthRepository,
  type AuthSecretService,
  type PasswordHasher,
} from './auth.ports';

@Injectable()
export class ConfirmPasswordReset {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
    @Inject(AUTH_SECRET_SERVICE) private readonly secrets: AuthSecretService,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(rawToken: string, password: string): Promise<void> {
    const passwordHash = await this.passwords.hash(password);
    const consumed = await this.transactions.run((context) =>
      this.repository.consumePasswordReset(
        context,
        this.secrets.hash(rawToken),
        passwordHash,
        new Date(),
      ),
    );
    if (!consumed) {
      throw new AuthApplicationError('RESET_TOKEN_INVALID');
    }
  }
}
