import type { SiteConfigDocument } from './site-config-v4';
import type { SiteConfigSchemaVersion } from '../../../shared/config/site-config-rollout';

export interface Release {
  readonly id: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly version: number;
  readonly siteConfig: SiteConfigDocument;
  readonly schemaVersion: SiteConfigSchemaVersion;
  readonly publishedAt: Date;
}
