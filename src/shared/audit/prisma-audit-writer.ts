import { Injectable } from '@nestjs/common';
import type {
  AppendedAuditEvent,
  AuditEventRequest,
  AuditWriter,
  LeadSubmittedAuditEvent,
  MediaDeletionMarkedAuditEvent,
  MediaVerifiedAuditEvent,
  MembershipRoleChangedAuditEvent,
  ProjectPublishedAuditEvent,
  ReleaseActivatedAuditEvent,
} from './audit-writer';
import type { TransactionContext } from '../database/transaction-runner';
import {
  PrismaTransactionClientService,
  TransactionRunner,
} from '../database/transaction-runner';

interface AuditSequenceRow {
  readonly nextValue: bigint;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface AuditTransactionClient {
  $executeRaw(
    query: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<number>;
  readonly auditEvent: {
    create(arguments_: {
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<unknown>;
  };
  readonly auditSequence: {
    update(arguments_: {
      readonly where: { readonly id: number };
      readonly data: { readonly nextValue: bigint };
    }): Promise<unknown>;
  };
  $queryRaw<T>(
    query: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<T>;
}

function assertLeadSubmittedEvent(event: LeadSubmittedAuditEvent): void {
  const { metadata } = event;
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata) ||
    Object.keys(metadata).sort().join(',') !== 'outcome,releaseId' ||
    typeof metadata.releaseId !== 'string' ||
    !uuidPattern.test(metadata.releaseId) ||
    metadata.outcome !== 'accepted'
  ) {
    throw new Error('LEAD_SUBMITTED metadata is not allowlisted');
  }
  if (!uuidPattern.test(event.resourceId)) {
    throw new Error('LEAD_SUBMITTED resourceId must be a UUID');
  }
}

function assertMembershipRoleChangedEvent(
  event: MembershipRoleChangedAuditEvent,
): void {
  const { metadata } = event;
  if (
    !uuidPattern.test(event.workspaceId) ||
    !uuidPattern.test(event.actorUserId) ||
    event.resourceId.split(':').length !== 2 ||
    !event.resourceId.split(':').every((value) => uuidPattern.test(value)) ||
    typeof metadata !== 'object' ||
    metadata === null ||
    Object.keys(metadata).sort().join(',') !== 'fromRole,toRole' ||
    !['OWNER', 'EDITOR'].includes(metadata.fromRole) ||
    !['OWNER', 'EDITOR'].includes(metadata.toRole) ||
    metadata.fromRole === metadata.toRole
  ) {
    throw new Error('MEMBERSHIP_ROLE_CHANGED metadata is not allowlisted');
  }
}

function assertReleaseAuditEvent(
  event: ProjectPublishedAuditEvent | ReleaseActivatedAuditEvent,
): void {
  const { metadata } = event;
  if (
    !['PROJECT_PUBLISHED', 'RELEASE_ACTIVATED'].includes(event.action) ||
    !uuidPattern.test(event.workspaceId) ||
    !uuidPattern.test(event.actorUserId) ||
    event.resourceType !== 'Release' ||
    !uuidPattern.test(event.resourceId) ||
    typeof event.requestId !== 'string' ||
    event.requestId.length === 0 ||
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata) ||
    Object.keys(metadata).sort().join(',') !== 'projectId,version' ||
    !uuidPattern.test(metadata.projectId) ||
    !Number.isSafeInteger(metadata.version) ||
    metadata.version < 1
  ) {
    throw new Error(`${event.action} event is not allowlisted`);
  }
}

function assertMediaAuditEvent(
  event: MediaVerifiedAuditEvent | MediaDeletionMarkedAuditEvent,
): void {
  const expectedOutcome =
    event.action === 'MEDIA_VERIFIED' ? 'ready' : 'deleting';
  if (
    !uuidPattern.test(event.workspaceId) ||
    !uuidPattern.test(event.actorUserId) ||
    event.resourceType !== 'MediaAsset' ||
    !uuidPattern.test(event.resourceId) ||
    typeof event.requestId !== 'string' ||
    !uuidPattern.test(event.requestId) ||
    typeof event.metadata !== 'object' ||
    event.metadata === null ||
    Array.isArray(event.metadata) ||
    Object.keys(event.metadata).join(',') !== 'outcome' ||
    event.metadata.outcome !== expectedOutcome
  ) {
    throw new Error(`${event.action} event is not allowlisted`);
  }
}

function unsupportedAuditAction(event: never): never {
  const action = (event as { readonly action?: unknown }).action;
  throw new Error(`Audit action is not allowlisted: ${String(action)}`);
}

function auditMetadata(
  event: AuditEventRequest,
): Readonly<Record<string, unknown>> {
  switch (event.action) {
    case 'LEAD_SUBMITTED':
      return {
        releaseId: event.metadata.releaseId,
        outcome: event.metadata.outcome,
      };
    case 'MEMBERSHIP_ROLE_CHANGED':
      return {
        fromRole: event.metadata.fromRole,
        toRole: event.metadata.toRole,
      };
    case 'PROJECT_PUBLISHED':
    case 'RELEASE_ACTIVATED':
      return {
        projectId: event.metadata.projectId,
        version: event.metadata.version,
      };
    case 'MEDIA_VERIFIED':
    case 'MEDIA_DELETION_MARKED':
      return { outcome: event.metadata.outcome };
    default:
      return unsupportedAuditAction(event);
  }
}

@Injectable()
export class PrismaAuditWriter implements AuditWriter {
  constructor(private readonly transactions: TransactionRunner) {}

  async append(
    context: TransactionContext,
    event: AuditEventRequest,
  ): Promise<AppendedAuditEvent> {
    switch (event.action) {
      case 'LEAD_SUBMITTED':
        assertLeadSubmittedEvent(event);
        break;
      case 'MEMBERSHIP_ROLE_CHANGED':
        assertMembershipRoleChangedEvent(event);
        break;
      case 'PROJECT_PUBLISHED':
      case 'RELEASE_ACTIVATED':
        assertReleaseAuditEvent(event);
        break;
      case 'MEDIA_VERIFIED':
      case 'MEDIA_DELETION_MARKED':
        assertMediaAuditEvent(event);
        break;
      default:
        return unsupportedAuditAction(event);
    }

    return this.transactions[PrismaTransactionClientService](
      context,
      async (client) => {
        const transaction = client as AuditTransactionClient;
        await transaction.$executeRaw`
          SELECT set_config('nexus.audit_writer', 'enabled', true)
        `;
        const rows = await transaction.$queryRaw<AuditSequenceRow[]>`
        SELECT "nextValue"
        FROM "AuditSequence"
        WHERE "id" = 1
        FOR UPDATE
      `;
        const sequence = rows[0]?.nextValue;
        if (sequence === undefined) {
          throw new Error('AuditSequence singleton is missing');
        }

        await transaction.auditSequence.update({
          where: { id: 1 },
          data: { nextValue: sequence + 1n },
        });
        await transaction.auditEvent.create({
          data: {
            eventId: event.eventId,
            sequence,
            ...(event.workspaceId === undefined
              ? {}
              : { workspaceId: event.workspaceId }),
            ...(event.actorUserId === undefined
              ? {}
              : { actorUserId: event.actorUserId }),
            action: event.action,
            resourceType: event.resourceType,
            resourceId: event.resourceId,
            metadata: auditMetadata(event),
            requestId: event.requestId,
          },
        });
        await transaction.$executeRaw`
          SELECT set_config('nexus.audit_writer', 'disabled', true)
        `;

        return { eventId: event.eventId, sequence };
      },
    );
  }
}
