export interface EditorProjectDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly publicSlug: string;
  readonly publicUrl: string;
  readonly siteConfig: Readonly<Record<string, unknown>>;
  readonly draftSchemaVersion: 4;
  readonly draftVersion: number;
}

export interface ProjectSummaryDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly publicSlug: string;
  readonly publicUrl: string;
  readonly updatedAt: string;
}

export interface ProjectRevisionMetadataDto {
  readonly id: string;
  readonly projectId: string;
  readonly version: number;
  readonly schemaVersion: 4;
  readonly createdAt: string;
}

export interface CursorPageDto<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
