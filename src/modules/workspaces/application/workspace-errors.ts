export type WorkspaceErrorCode =
  'FORBIDDEN' | 'LAST_WORKSPACE_OWNER' | 'NOT_FOUND';

export class WorkspaceApplicationError extends Error {
  constructor(readonly code: WorkspaceErrorCode) {
    super(code);
  }
}
