import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  NOTIFICATION_ENQUEUE,
  type NotificationEnqueue,
} from '../../notifications/application/public';
import { TransactionRunner } from '../../../shared/database/transaction-runner';
import {
  AUTH_REPOSITORY,
  AUTH_SECRET_SERVICE,
  PASSWORD_HASHER,
  type AuthRepository,
  type AuthSecretService,
  type PasswordHasher,
} from './auth.ports';
import type { RegistrationResult } from './auth-results';

const verificationLifetimeMilliseconds = 24 * 60 * 60 * 1000;

@Injectable()
export class RegisterUser {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasher,
    @Inject(AUTH_SECRET_SERVICE) private readonly secrets: AuthSecretService,
    @Inject(NOTIFICATION_ENQUEUE)
    private readonly notifications: NotificationEnqueue,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(email: string, password: string): Promise<RegistrationResult> {
    const passwordHash = await this.passwords.hash(password);
    const rawSecret = this.secrets.generate();
    const userId = randomUUID();
    const tokenId = randomUUID();
    const eventId = randomUUID();
    const expiresAt = new Date(Date.now() + verificationLifetimeMilliseconds);

    await this.transactions.run(async (context) => {
      await this.repository.createRegistration(context, {
        userId,
        email,
        passwordHash,
        token: {
          id: tokenId,
          tokenHash: this.secrets.hash(rawSecret),
          expiresAt,
        },
      });
      await this.notifications.enqueue(context, {
        eventId,
        kind: 'AUTH_EMAIL_VERIFICATION',
        userId,
        tokenRecordId: tokenId,
        secretCiphertext: this.secrets.encrypt(rawSecret),
        secretExpiresAt: expiresAt,
      });
    });

    return { userId, email, emailVerificationRequired: true };
  }
}
