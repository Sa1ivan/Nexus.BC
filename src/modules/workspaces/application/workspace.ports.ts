import type { TransactionContext } from '../../../shared/database/transaction-runner';

export const WORKSPACE_REPOSITORY = Symbol('WorkspaceRepository');

export type WorkspaceRole = 'OWNER' | 'EDITOR';

export interface WorkspaceView {
  readonly id: string;
  readonly name: string;
  readonly role: WorkspaceRole;
}

export interface MembershipRoleView {
  readonly role: WorkspaceRole;
  readonly userId: string;
  readonly workspaceId: string;
}

export type ChangeMembershipRoleResult =
  | {
      readonly kind: 'changed';
      readonly fromRole: WorkspaceRole;
      readonly membership: MembershipRoleView;
    }
  | {
      readonly kind: 'unchanged';
      readonly membership: MembershipRoleView;
    }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'last-owner' };

export interface WorkspaceRepository {
  create(
    context: TransactionContext,
    input: {
      readonly id: string;
      readonly name: string;
      readonly ownerUserId: string;
    },
  ): Promise<WorkspaceView>;
  findForUser(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceView | null>;
  changeMembershipRole(
    context: TransactionContext,
    input: {
      readonly actorUserId: string;
      readonly role: WorkspaceRole;
      readonly targetUserId: string;
      readonly workspaceId: string;
    },
  ): Promise<ChangeMembershipRoleResult>;
}
