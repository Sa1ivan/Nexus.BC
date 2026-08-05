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
  type AuthRepository,
  type AuthSecretService,
} from './auth.ports';

const resetLifetimeMilliseconds = 60 * 60 * 1000;

@Injectable()
export class RequestPasswordReset {
  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
    @Inject(AUTH_SECRET_SERVICE) private readonly secrets: AuthSecretService,
    @Inject(NOTIFICATION_ENQUEUE)
    private readonly notifications: NotificationEnqueue,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(email: string): Promise<void> {
    const user = await this.repository.findUserByEmail(email);
    if (user === null) {
      return;
    }
    const rawSecret = this.secrets.generate();
    const tokenId = randomUUID();
    const expiresAt = new Date(Date.now() + resetLifetimeMilliseconds);
    await this.transactions.run(async (context) => {
      await this.repository.createPasswordReset(context, {
        id: tokenId,
        userId: user.userId,
        tokenHash: this.secrets.hash(rawSecret),
        expiresAt,
      });
      await this.notifications.enqueue(context, {
        eventId: randomUUID(),
        kind: 'AUTH_PASSWORD_RESET',
        userId: user.userId,
        tokenRecordId: tokenId,
        secretCiphertext: this.secrets.encrypt(rawSecret),
        secretExpiresAt: expiresAt,
      });
    });
  }
}
