export const WORKSPACE_ACCESS = Symbol('WorkspaceAccess');

export type WorkspaceAccessRole = 'OWNER' | 'EDITOR';

export interface WorkspaceAccessView {
  readonly id: string;
  readonly role: WorkspaceAccessRole;
}

export interface WorkspaceAccess {
  findForUser(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceAccessView | null>;
}
