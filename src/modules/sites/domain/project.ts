import type { SiteConfigDocument } from './site-config-v4';
import type { SiteConfigSchemaVersion } from '../../../shared/config/site-config-rollout';

export interface Project {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly publicSlug: string;
  readonly draft: SiteConfigDocument;
  readonly draftSchemaVersion: SiteConfigSchemaVersion;
  readonly draftVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
