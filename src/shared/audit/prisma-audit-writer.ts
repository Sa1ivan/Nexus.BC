import { Injectable } from '@nestjs/common';
import type {
  AppendedAuditEvent,
  AuditEventRequest,
  AuditWriter,
  LeadSubmittedAuditEvent,
  MembershipRoleChangedAuditEvent,
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

@Injectable()
export class PrismaAuditWriter implements AuditWriter {
  constructor(private readonly transactions: TransactionRunner) {}

  async append(
    context: TransactionContext,
    event: AuditEventRequest,
  ): Promise<AppendedAuditEvent> {
    if (event.action === 'LEAD_SUBMITTED') {
      assertLeadSubmittedEvent(event);
    } else {
      assertMembershipRoleChangedEvent(event);
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
            metadata:
              event.action === 'LEAD_SUBMITTED'
                ? {
                    releaseId: event.metadata.releaseId,
                    outcome: event.metadata.outcome,
                  }
                : {
                    fromRole: event.metadata.fromRole,
                    toRole: event.metadata.toRole,
                  },
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
