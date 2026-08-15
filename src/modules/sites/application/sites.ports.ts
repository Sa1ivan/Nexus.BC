import type { TransactionContext } from '../../../shared/database/transaction-runner';
import type { Project } from '../domain/project';
import type { ProjectRevision } from '../domain/project-revision';
import type { Release } from '../domain/release';
import type { SiteConfigDocument } from '../domain/site-config-v4';
import type { CanonicalSiteConfigInput } from '../domain/site-config-write-handlers';
import type { SiteConfigSchemaVersion } from '../../../shared/config/site-config-rollout';

export const SITE_REPOSITORY = Symbol('SiteRepository');

export interface CreateProjectRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly operationId: string;
  readonly name: string;
  readonly publicSlug: string;
  readonly siteConfig: CanonicalSiteConfigInput;
}

export interface SaveDraftRecord {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly expectedDraftVersion: number;
  readonly siteConfig: CanonicalSiteConfigInput;
}

export interface PublishProjectRecord {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly expectedDraftVersion: number;
  readonly siteConfig: CanonicalSiteConfigInput;
}

export interface ActivateReleaseRecord {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly releaseId: string;
}

export interface FindReleaseForActivationRecord {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly releaseId: string;
}

export interface PublicReleaseSnapshot {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly version: number;
  readonly siteConfig: SiteConfigDocument;
  readonly schemaVersion: SiteConfigSchemaVersion;
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

export type PublishProjectResult =
  | { readonly kind: 'published'; readonly release: Release }
  | { readonly kind: 'not-found' }
  | {
      readonly kind: 'version-conflict';
      readonly currentDraftVersion: number;
    }
  | { readonly kind: 'operation-conflict' };

export type ActivateReleaseResult =
  | { readonly kind: 'activated'; readonly release: Release }
  | { readonly kind: 'not-found' };

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
  findReleaseForWorkspace(
    workspaceId: string,
    projectId: string,
    releaseId: string,
  ): Promise<Release | null>;
  findActiveReleaseByPublicSlug(
    publicSlug: string,
  ): Promise<PublicReleaseSnapshot | null>;
  saveDraft(
    context: TransactionContext,
    input: SaveDraftRecord,
  ): Promise<SaveDraftResult>;
  publishProject(
    context: TransactionContext,
    input: PublishProjectRecord,
  ): Promise<PublishProjectResult>;
  activateRelease(
    context: TransactionContext,
    input: ActivateReleaseRecord,
  ): Promise<ActivateReleaseResult>;
  findReleaseForActivation(
    context: TransactionContext,
    input: FindReleaseForActivationRecord,
  ): Promise<Release | null>;
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
