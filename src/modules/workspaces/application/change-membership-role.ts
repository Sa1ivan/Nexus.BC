import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AUDIT_WRITER,
  type AuditWriter,
} from '../../../shared/audit/audit-writer';
import { TransactionRunner } from '../../../shared/database/transaction-runner';
import { WorkspaceApplicationError } from './workspace-errors';
import {
  WORKSPACE_REPOSITORY,
  type MembershipRoleView,
  type WorkspaceRepository,
  type WorkspaceRole,
} from './workspace.ports';

@Injectable()
export class ChangeMembershipRole {
  constructor(
    @Inject(WORKSPACE_REPOSITORY)
    private readonly repository: WorkspaceRepository,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
    private readonly transactions: TransactionRunner,
  ) {}

  execute(input: {
    readonly actorUserId: string;
    readonly requestId: string;
    readonly role: WorkspaceRole;
    readonly targetUserId: string;
    readonly workspaceId: string;
  }): Promise<MembershipRoleView> {
    return this.transactions.run(async (context) => {
      const result = await this.repository.changeMembershipRole(context, input);
      if (result.kind === 'not-found') {
        throw new WorkspaceApplicationError('NOT_FOUND');
      }
      if (result.kind === 'forbidden') {
        throw new WorkspaceApplicationError('FORBIDDEN');
      }
      if (result.kind === 'last-owner') {
        throw new WorkspaceApplicationError('LAST_WORKSPACE_OWNER');
      }
      if (result.kind === 'changed') {
        await this.audit.append(context, {
          eventId: randomUUID(),
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          action: 'MEMBERSHIP_ROLE_CHANGED',
          resourceType: 'Membership',
          resourceId: `${input.workspaceId}:${input.targetUserId}`,
          metadata: {
            fromRole: result.fromRole,
            toRole: result.membership.role,
          },
          requestId: input.requestId,
        });
      }
      return result.membership;
    });
  }
}
