import type { SiteConfigDocument } from './site-config-v4';

export interface Project {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly publicSlug: string;
  readonly draft: SiteConfigDocument;
  readonly draftSchemaVersion: 4;
  readonly draftVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
