import { Injectable } from '@nestjs/common';
import type {
  AuthNotification,
  EnqueuedNotification,
  NotificationEnqueue,
} from '../application/public';
import type { TransactionContext } from '../../../shared/database/transaction-runner';
import {
  PrismaTransactionClientService,
  TransactionRunner,
} from '../../../shared/database/transaction-runner';

interface OutboxTransactionClient {
  readonly outbox: {
    create(arguments_: {
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<unknown>;
  };
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function assertAuthNotification(notification: AuthNotification): void {
  if (!uuidPattern.test(notification.eventId)) {
    throw new Error('Notification eventId must be a UUID');
  }
  if (!uuidPattern.test(notification.userId)) {
    throw new Error('Notification userId must be a UUID');
  }
  if (!uuidPattern.test(notification.tokenRecordId)) {
    throw new Error('Notification tokenRecordId must be a UUID');
  }
  if (
    notification.kind !== 'AUTH_EMAIL_VERIFICATION' &&
    notification.kind !== 'AUTH_PASSWORD_RESET'
  ) {
    throw new Error('Notification kind is not supported');
  }
  if (
    !(notification.secretCiphertext instanceof Uint8Array) ||
    notification.secretCiphertext.byteLength === 0
  ) {
    throw new Error('Notification secretCiphertext must be non-empty');
  }
  if (
    !(notification.secretExpiresAt instanceof Date) ||
    !Number.isFinite(notification.secretExpiresAt.getTime()) ||
    notification.secretExpiresAt.getTime() <= Date.now()
  ) {
    throw new Error('Notification secretExpiresAt must be in the future');
  }
}

function businessIdempotencyKey(notification: AuthNotification): string {
  const operation =
    notification.kind === 'AUTH_EMAIL_VERIFICATION' ? 'verify' : 'reset';
  return `auth:${operation}:${notification.tokenRecordId}`;
}

@Injectable()
export class PrismaOutbox implements NotificationEnqueue {
  constructor(private readonly transactions: TransactionRunner) {}

  async enqueue(
    context: TransactionContext,
    notification: AuthNotification,
  ): Promise<EnqueuedNotification> {
    assertAuthNotification(notification);

    return this.transactions[PrismaTransactionClientService](
      context,
      async (client) => {
        const transaction = client as OutboxTransactionClient;
        await transaction.outbox.create({
          data: {
            eventId: notification.eventId,
            businessIdempotencyKey: businessIdempotencyKey(notification),
            kind: notification.kind,
            aggregateType: 'User',
            aggregateId: notification.userId,
            payload: { tokenRecordId: notification.tokenRecordId },
            secretCiphertext: new Uint8Array(notification.secretCiphertext),
            secretExpiresAt: new Date(notification.secretExpiresAt.getTime()),
          },
        });
        return { eventId: notification.eventId };
      },
    );
  }
}
