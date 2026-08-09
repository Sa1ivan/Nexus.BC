import type { TransactionContext } from '../../../shared/database/transaction-runner';
import type { Project } from '../domain/project';
import type { ProjectRevision } from '../domain/project-revision';
import type { SiteConfigDocument } from '../domain/site-config-v4';

export const SITE_REPOSITORY = Symbol('SiteRepository');

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
  | { readonly kind: 'saved'; readonly project: Project }
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
  ): Promise<Project>;
  findForWorkspace(
    workspaceId: string,
    projectId: string,
  ): Promise<Project | null>;
  findRevisionForWorkspace(
    workspaceId: string,
    projectId: string,
    version: number,
  ): Promise<ProjectRevision | null>;
  saveDraft(
    context: TransactionContext,
    input: SaveDraftRecord,
  ): Promise<SaveDraftResult>;
  listRevisions(
    workspaceId: string,
    projectId: string,
    page?: CursorInput,
  ): Promise<CursorPage<ProjectRevision>>;
  listProjectSummaries(
    workspaceId: string,
    page?: CursorInput,
  ): Promise<CursorPage<ProjectSummary>>;
}
