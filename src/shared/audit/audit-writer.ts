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

export interface MembershipRoleChangedAuditEvent {
  readonly eventId: string;
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly action: 'MEMBERSHIP_ROLE_CHANGED';
  readonly resourceType: 'Membership';
  readonly resourceId: string;
  readonly metadata: {
    readonly fromRole: 'OWNER' | 'EDITOR';
    readonly toRole: 'OWNER' | 'EDITOR';
  };
  readonly requestId: string;
}

interface ReleaseAuditEventBase {
  readonly eventId: string;
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly resourceType: 'Release';
  readonly resourceId: string;
  readonly metadata: {
    readonly projectId: string;
    readonly version: number;
  };
  readonly requestId: string;
}

export interface ProjectPublishedAuditEvent extends ReleaseAuditEventBase {
  readonly action: 'PROJECT_PUBLISHED';
}

export interface ReleaseActivatedAuditEvent extends ReleaseAuditEventBase {
  readonly action: 'RELEASE_ACTIVATED';
}

export type AuditEventRequest =
  | LeadSubmittedAuditEvent
  | MembershipRoleChangedAuditEvent
  | ProjectPublishedAuditEvent
  | ReleaseActivatedAuditEvent;

export interface AppendedAuditEvent {
  readonly eventId: string;
  readonly sequence: bigint;
}

export interface AuditWriter {
  append(
    context: TransactionContext,
    event: AuditEventRequest,
  ): Promise<AppendedAuditEvent>;
}
