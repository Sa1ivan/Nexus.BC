import type { TransactionContext } from '../../../shared/database/transaction-runner';

export const NOTIFICATION_ENQUEUE = Symbol('NotificationEnqueue');

export type AuthNotificationKind =
  'AUTH_EMAIL_VERIFICATION' | 'AUTH_PASSWORD_RESET';

export interface AuthNotification {
  readonly eventId: string;
  readonly kind: AuthNotificationKind;
  readonly userId: string;
  readonly tokenRecordId: string;
  readonly secretCiphertext: Uint8Array;
  readonly secretExpiresAt: Date;
}

export interface EnqueuedNotification {
  readonly eventId: string;
}

export interface NotificationEnqueue {
  enqueue(
    context: TransactionContext,
    notification: AuthNotification,
  ): Promise<EnqueuedNotification>;
}
