import type { SiteConfigDocument } from './site-config-v4';

export interface Release {
  readonly id: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly version: number;
  readonly siteConfig: SiteConfigDocument;
  readonly schemaVersion: 4;
  readonly publishedAt: Date;
}
