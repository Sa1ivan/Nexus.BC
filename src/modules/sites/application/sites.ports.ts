import type { TransactionContext } from '../../../shared/database/transaction-runner';

export const SITE_REPOSITORY = Symbol('SiteRepository');

export type SiteConfigDocument = Readonly<Record<string, unknown>>;

export interface CreateProjectRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly name: string;
  readonly publicSlug: string;
  readonly siteConfig: SiteConfigDocument;
}

export interface SaveDraftRecord {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly expectedDraftVersion: number;
  readonly siteConfig: SiteConfigDocument;
}

export interface StoredProject {
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

export interface StoredProjectRevision {
  readonly id: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly version: number;
  readonly siteConfig: SiteConfigDocument;
  readonly schemaVersion: 4;
  readonly createdAt: Date;
}

export interface ProjectSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly publicSlug: string;
  readonly draftVersion: number;
  readonly updatedAt: Date;
}

export interface CursorInput {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export type SaveDraftResult =
  | { readonly kind: 'saved'; readonly project: StoredProject }
  | { readonly kind: 'not-found' }
  | {
      readonly kind: 'version-conflict';
      readonly currentDraftVersion: number;
    }
  | { readonly kind: 'operation-conflict' };

export interface SiteRepository {
  create(
    context: TransactionContext,
    input: CreateProjectRecord,
  ): Promise<StoredProject>;
  findForWorkspace(
    workspaceId: string,
    projectId: string,
  ): Promise<StoredProject | null>;
  saveDraft(
    context: TransactionContext,
    input: SaveDraftRecord,
  ): Promise<SaveDraftResult>;
  listRevisions(
    workspaceId: string,
    projectId: string,
    page?: CursorInput,
  ): Promise<CursorPage<StoredProjectRevision>>;
  listProjectSummaries(
    workspaceId: string,
    page?: CursorInput,
  ): Promise<CursorPage<ProjectSummary>>;
}
