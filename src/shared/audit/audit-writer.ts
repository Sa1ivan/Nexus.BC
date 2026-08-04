import type { TransactionContext } from '../database/transaction-runner';

export const AUDIT_WRITER = 'AUDIT_WRITER';

export interface LeadSubmittedAuditEvent {
  readonly eventId: string;
  readonly workspaceId?: string;
  readonly actorUserId?: string;
  readonly action: 'LEAD_SUBMITTED';
  readonly resourceType: 'Lead';
  readonly resourceId: string;
  readonly metadata: {
    readonly releaseId: string;
    readonly outcome: 'accepted';
  };
  readonly requestId: string;
}

export interface AppendedAuditEvent {
  readonly eventId: string;
  readonly sequence: bigint;
}

export interface AuditWriter {
  append(
    context: TransactionContext,
    event: LeadSubmittedAuditEvent,
  ): Promise<AppendedAuditEvent>;
}
