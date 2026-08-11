export interface MediaImportBatch {
  readonly id: string;
  readonly workspaceId: string;
  readonly attachedProjectId: string | null;
  readonly expiresAt: Date;
  readonly attachedAt: Date | null;
  readonly createdAt: Date;
}
