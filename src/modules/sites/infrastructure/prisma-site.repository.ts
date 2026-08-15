import { Inject, Injectable } from '@nestjs/common';
import { PrismaClientService } from '../../../shared/database/prisma.service';
import type { SiteConfigSchemaVersion } from '../../../shared/config/site-config-rollout';
import type { TransactionContext } from '../../../shared/database/transaction-runner';
import {
  PrismaTransactionClientService,
  TransactionRunner,
} from '../../../shared/database/transaction-runner';
import type {
  ActivateReleaseRecord,
  ActivateReleaseResult,
  CreateProjectRecord,
  CursorInput,
  CursorPage,
  FindReleaseForActivationRecord,
  ProjectSummary,
  PublicReleaseSnapshot,
  PublishProjectRecord,
  PublishProjectResult,
  SaveDraftRecord,
  SaveDraftResult,
  SiteRepository,
} from '../application/sites.ports';
import { managedMediaAssetIds } from '../application/managed-media-references';
import type {
  RetainedMediaReferenceInput,
  SitesRetainedMediaReference,
} from '../application/public';
import { InvalidSiteCursorError } from '../application/sites-errors';
import type { Project } from '../domain/project';
import type { ProjectRevision } from '../domain/project-revision';
import type { Release } from '../domain/release';
import {
  type SiteConfigDocument,
  validateAndCanonicalizeSiteConfigV4Json,
} from '../domain/site-config-v4';
import { validateAndCanonicalizeSiteConfigV5Json } from '../domain/site-config-v5';
import { SiteConfigRolloutGuard } from './site-config-rollout-guard';

interface ProjectRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly publicSlug: string;
  readonly draft: unknown;
  readonly draftSchemaVersion: number;
  readonly draftVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface RevisionRow {
  readonly id: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly version: number;
  readonly siteConfig: unknown;
  readonly schemaVersion: number;
  readonly createdAt: Date;
}

interface SummaryRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly publicSlug: string;
  readonly draftVersion: number;
  readonly updatedAt: Date;
}

interface ReleaseRow {
  readonly id: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly version: number;
  readonly siteConfig: unknown;
  readonly schemaVersion: number;
  readonly publishedAt: Date;
}

interface ActiveReleaseRow {
  readonly projectId: string;
  readonly releaseId: string;
  readonly activatedAt: Date;
}

interface PublicReleaseRow {
  readonly id: string;
  readonly version: number;
  readonly siteConfig: unknown;
  readonly schemaVersion: number;
}

interface PublicReleaseProjectRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly activeRelease: {
    readonly release: PublicReleaseRow;
  } | null;
}

interface SitePrismaClient {
  readonly project: {
    findFirst(
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<ProjectRow | null>;
    findMany(
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<SummaryRow[]>;
    findUnique(
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<PublicReleaseProjectRow | null>;
  };
  readonly projectRevision: {
    findFirst(
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<RevisionRow | null>;
    findMany(
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<RevisionRow[]>;
  };
  readonly release: {
    findFirst(
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<ReleaseRow | null>;
  };
}

interface SiteTransactionClient extends SitePrismaClient {
  $queryRaw<T>(
    query: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<T>;
  readonly project: SitePrismaClient['project'] & {
    create(arguments_: Readonly<Record<string, unknown>>): Promise<ProjectRow>;
    updateMany(
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<{ readonly count: number }>;
  };
  readonly projectRevision: SitePrismaClient['projectRevision'] & {
    create(arguments_: Readonly<Record<string, unknown>>): Promise<RevisionRow>;
    findFirst(
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<{ readonly id: string } | null>;
  };
  readonly release: SitePrismaClient['release'] & {
    create(arguments_: Readonly<Record<string, unknown>>): Promise<ReleaseRow>;
  };
  readonly activeRelease: {
    upsert(
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<ActiveReleaseRow>;
  };
}

interface RevisionCursor {
  readonly kind: 'revision';
  readonly version: 1;
  readonly revisionVersion: number;
  readonly id: string;
}

interface SummaryCursor {
  readonly kind: 'summary';
  readonly version: 1;
  readonly updatedAt: string;
  readonly id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storedSiteConfig(
  value: unknown,
  version: SiteConfigSchemaVersion,
  owner: string,
): SiteConfigDocument {
  const invalidMessage =
    owner === 'release'
      ? `Stored release SiteConfig v${version} snapshot is invalid`
      : `Stored ${owner} SiteConfig v${version} is invalid`;
  let serialized: string;
  try {
    const candidate = JSON.stringify(value);
    if (candidate === undefined) throw new Error('not JSON');
    serialized = candidate;
  } catch {
    throw new Error(invalidMessage);
  }
  const validated =
    version === 4
      ? validateAndCanonicalizeSiteConfigV4Json(serialized)
      : validateAndCanonicalizeSiteConfigV5Json(serialized);
  if (!validated.ok) {
    throw new Error(invalidMessage);
  }
  return validated.value;
}

function schemaVersion(value: number): SiteConfigSchemaVersion {
  if (value !== 4 && value !== 5)
    throw new Error('Stored SiteConfig schema version must be 4 or 5');
  return value;
}

function storedProject(row: ProjectRow): Project {
  const version = schemaVersion(row.draftSchemaVersion);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    publicSlug: row.publicSlug,
    draft: storedSiteConfig(row.draft, version, 'project draft'),
    draftSchemaVersion: version,
    draftVersion: row.draftVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function storedRevision(row: RevisionRow): ProjectRevision {
  const version = schemaVersion(row.schemaVersion);
  return {
    id: row.id,
    projectId: row.projectId,
    operationId: row.operationId,
    version: row.version,
    siteConfig: storedSiteConfig(row.siteConfig, version, 'revision'),
    schemaVersion: version,
    createdAt: row.createdAt,
  };
}

function storedRelease(row: ReleaseRow): Release {
  const version = schemaVersion(row.schemaVersion);
  return {
    id: row.id,
    projectId: row.projectId,
    operationId: row.operationId,
    version: row.version,
    siteConfig: storedSiteConfig(row.siteConfig, version, 'release'),
    schemaVersion: version,
    publishedAt: row.publishedAt,
  };
}

function storedPublicRelease(
  row: PublicReleaseRow,
  project: Pick<PublicReleaseProjectRow, 'id' | 'workspaceId'>,
): PublicReleaseSnapshot {
  const version = schemaVersion(row.schemaVersion);
  return {
    id: row.id,
    workspaceId: project.workspaceId,
    projectId: project.id,
    version: row.version,
    siteConfig: storedSiteConfig(row.siteConfig, version, 'public release'),
    schemaVersion: version,
  };
}

function projectSummary(row: SummaryRow): ProjectSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    publicSlug: row.publicSlug,
    draftVersion: row.draftVersion,
    updatedAt: row.updatedAt,
  };
}

function pageLimit(page: CursorInput | undefined): number {
  const limit = page?.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('page limit must be between 1 and 100');
  }
  return limit;
}

function encodeCursor(value: RevisionCursor | SummaryCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidSiteCursorError();
  }
  if (!isRecord(parsed)) throw new InvalidSiteCursorError();
  return parsed;
}

function revisionCursor(cursor: string | undefined): RevisionCursor | null {
  if (cursor === undefined) return null;
  const parsed = decodeCursor(cursor);
  if (
    parsed['kind'] !== 'revision' ||
    parsed['version'] !== 1 ||
    typeof parsed['revisionVersion'] !== 'number' ||
    !Number.isSafeInteger(parsed['revisionVersion']) ||
    typeof parsed['id'] !== 'string' ||
    parsed['id'].length === 0
  ) {
    throw new InvalidSiteCursorError();
  }
  return {
    kind: 'revision',
    version: 1,
    revisionVersion: parsed['revisionVersion'],
    id: parsed['id'],
  };
}

function summaryCursor(cursor: string | undefined): SummaryCursor | null {
  if (cursor === undefined) return null;
  const parsed = decodeCursor(cursor);
  if (
    parsed['kind'] !== 'summary' ||
    parsed['version'] !== 1 ||
    typeof parsed['updatedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(parsed['updatedAt'])) ||
    typeof parsed['id'] !== 'string' ||
    parsed['id'].length === 0
  ) {
    throw new InvalidSiteCursorError();
  }
  return {
    kind: 'summary',
    version: 1,
    updatedAt: parsed['updatedAt'],
    id: parsed['id'],
  };
}

function pagedResult<T, C>(
  rows: readonly T[],
  limit: number,
  cursorFor: (row: T) => C,
): { readonly items: readonly T[]; readonly next: C | null } {
  const items = rows.slice(0, limit);
  const lastItem = items.at(-1);
  return {
    items,
    next:
      rows.length > limit && lastItem !== undefined
        ? cursorFor(lastItem)
        : null,
  };
}

@Injectable()
export class PrismaSiteRepository
  implements SiteRepository, SitesRetainedMediaReference
{
  constructor(
    @Inject(PrismaClientService)
    private readonly prisma: SitePrismaClient,
    private readonly transactions: TransactionRunner,
    private readonly rollout: SiteConfigRolloutGuard,
  ) {}

  async create(
    context: TransactionContext,
    input: CreateProjectRecord,
  ): Promise<Project> {
    return this.withTransaction(context, async (transaction) => {
      const siteConfig = await this.rollout.prepareWrite(
        context,
        input.siteConfig,
      );
      const project = await transaction.project.create({
        data: {
          id: input.id,
          workspaceId: input.workspaceId,
          createOperationId: input.operationId,
          name: input.name,
          publicSlug: input.publicSlug,
          draft: siteConfig.document,
          draftSchemaVersion: siteConfig.schemaVersion,
          draftVersion: 1,
        },
      });
      await transaction.projectRevision.create({
        data: {
          projectId: input.id,
          operationId: input.operationId,
          version: 1,
          siteConfig: siteConfig.document,
          schemaVersion: siteConfig.schemaVersion,
        },
      });
      return storedProject(project);
    });
  }

  async findForWorkspace(
    workspaceId: string,
    projectId: string,
  ): Promise<Project | null> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId },
    });
    return project === null ? null : storedProject(project);
  }

  async findRevisionForWorkspace(
    workspaceId: string,
    projectId: string,
    version: number,
  ): Promise<ProjectRevision | null> {
    const revision = await this.prisma.projectRevision.findFirst({
      where: { projectId, version, project: { workspaceId } },
    });
    return revision === null ? null : storedRevision(revision);
  }

  async findReleaseForWorkspace(
    workspaceId: string,
    projectId: string,
    releaseId: string,
  ): Promise<Release | null> {
    const release = await this.prisma.release.findFirst({
      where: {
        id: releaseId,
        projectId,
        project: { workspaceId },
      },
    });
    return release === null ? null : storedRelease(release);
  }

  async findActiveReleaseByPublicSlug(
    publicSlug: string,
  ): Promise<PublicReleaseSnapshot | null> {
    const project = await this.prisma.project.findUnique({
      where: { publicSlug },
      select: {
        id: true,
        workspaceId: true,
        activeRelease: {
          select: {
            release: {
              select: {
                id: true,
                version: true,
                siteConfig: true,
                schemaVersion: true,
              },
            },
          },
        },
      },
    });
    const release = project?.activeRelease?.release;
    return project === null || release === undefined
      ? null
      : storedPublicRelease(release, project);
  }

  async saveDraft(
    context: TransactionContext,
    input: SaveDraftRecord,
  ): Promise<SaveDraftResult> {
    return this.withTransaction(context, async (transaction) => {
      const siteConfig = await this.rollout.prepareWrite(
        context,
        input.siteConfig,
      );
      const repeatedOperation = await transaction.projectRevision.findFirst({
        where: {
          projectId: input.projectId,
          operationId: input.operationId,
          project: { workspaceId: input.workspaceId },
        },
        select: { id: true },
      });
      if (repeatedOperation !== null) return { kind: 'operation-conflict' };

      const updated = await transaction.project.updateMany({
        where: {
          id: input.projectId,
          workspaceId: input.workspaceId,
          draftVersion: input.expectedDraftVersion,
        },
        data: {
          draft: siteConfig.document,
          draftSchemaVersion: siteConfig.schemaVersion,
          draftVersion: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        const current = await transaction.project.findFirst({
          where: { id: input.projectId, workspaceId: input.workspaceId },
        });
        return current === null
          ? { kind: 'not-found' }
          : {
              kind: 'version-conflict',
              currentDraftVersion: current.draftVersion,
            };
      }

      const version = input.expectedDraftVersion + 1;
      await transaction.projectRevision.create({
        data: {
          projectId: input.projectId,
          operationId: input.operationId,
          version,
          siteConfig: siteConfig.document,
          schemaVersion: siteConfig.schemaVersion,
        },
      });
      const project = await transaction.project.findFirst({
        where: { id: input.projectId, workspaceId: input.workspaceId },
      });
      if (project === null) {
        throw new Error('Saved project disappeared inside its transaction');
      }
      return { kind: 'saved', project: storedProject(project) };
    });
  }

  async publishProject(
    context: TransactionContext,
    input: PublishProjectRecord,
  ): Promise<PublishProjectResult> {
    return this.withTransaction(context, async (transaction) => {
      const siteConfig = await this.rollout.prepareWrite(
        context,
        input.siteConfig,
      );
      const repeatedOperation = await transaction.release.findFirst({
        where: {
          projectId: input.projectId,
          operationId: input.operationId,
          project: { workspaceId: input.workspaceId },
        },
      });
      if (repeatedOperation !== null) return { kind: 'operation-conflict' };

      const updated = await transaction.project.updateMany({
        where: {
          id: input.projectId,
          workspaceId: input.workspaceId,
          draftVersion: input.expectedDraftVersion,
        },
        data: {
          draft: siteConfig.document,
          draftSchemaVersion: siteConfig.schemaVersion,
          draftVersion: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        const current = await transaction.project.findFirst({
          where: { id: input.projectId, workspaceId: input.workspaceId },
        });
        return current === null
          ? { kind: 'not-found' }
          : {
              kind: 'version-conflict',
              currentDraftVersion: current.draftVersion,
            };
      }

      const version = input.expectedDraftVersion + 1;
      await transaction.projectRevision.create({
        data: {
          projectId: input.projectId,
          operationId: input.operationId,
          version,
          siteConfig: siteConfig.document,
          schemaVersion: siteConfig.schemaVersion,
        },
      });
      const release = await transaction.release.create({
        data: {
          projectId: input.projectId,
          operationId: input.operationId,
          version,
          siteConfig: siteConfig.document,
          schemaVersion: siteConfig.schemaVersion,
        },
      });
      await transaction.activeRelease.upsert({
        where: { projectId: input.projectId },
        create: {
          projectId: input.projectId,
          releaseId: release.id,
        },
        update: {
          releaseId: release.id,
          activatedAt: new Date(),
        },
      });
      return { kind: 'published', release: storedRelease(release) };
    });
  }

  async activateRelease(
    context: TransactionContext,
    input: ActivateReleaseRecord,
  ): Promise<ActivateReleaseResult> {
    return this.withTransaction(context, async (transaction) => {
      const release = await transaction.release.findFirst({
        where: {
          id: input.releaseId,
          projectId: input.projectId,
          project: { workspaceId: input.workspaceId },
        },
      });
      if (release === null) return { kind: 'not-found' };
      const stored = storedRelease(release);
      await transaction.activeRelease.upsert({
        where: { projectId: input.projectId },
        create: {
          projectId: input.projectId,
          releaseId: input.releaseId,
        },
        update: {
          releaseId: input.releaseId,
          activatedAt: new Date(),
        },
      });
      return { kind: 'activated', release: stored };
    });
  }

  async findReleaseForActivation(
    context: TransactionContext,
    input: FindReleaseForActivationRecord,
  ): Promise<Release | null> {
    return this.withTransaction(context, async (transaction) => {
      const release = await transaction.release.findFirst({
        where: {
          id: input.releaseId,
          projectId: input.projectId,
          project: { workspaceId: input.workspaceId },
        },
      });
      return release === null ? null : storedRelease(release);
    });
  }

  async hasRetainedReference(
    context: TransactionContext,
    input: RetainedMediaReferenceInput,
  ): Promise<boolean> {
    return this.withTransaction(context, async (transaction) => {
      const rows = await transaction.$queryRaw<
        readonly { readonly siteConfig: unknown }[]
      >`
        SELECT "draft" AS "siteConfig"
        FROM "Project"
        WHERE "id" = ${input.projectId}::uuid
          AND "workspaceId" = ${input.workspaceId}::uuid
        UNION ALL
        SELECT revision."siteConfig"
        FROM "ProjectRevision" revision
        INNER JOIN "Project" project ON project."id" = revision."projectId"
        WHERE project."id" = ${input.projectId}::uuid
          AND project."workspaceId" = ${input.workspaceId}::uuid
        UNION ALL
        SELECT release."siteConfig"
        FROM "Release" release
        INNER JOIN "Project" project ON project."id" = release."projectId"
        WHERE project."id" = ${input.projectId}::uuid
          AND project."workspaceId" = ${input.workspaceId}::uuid
      `;
      return rows.some(({ siteConfig }) =>
        managedMediaAssetIds(siteConfig).includes(input.assetId),
      );
    });
  }

  async listRevisions(
    workspaceId: string,
    projectId: string,
    page?: CursorInput,
  ): Promise<CursorPage<ProjectRevision>> {
    const limit = pageLimit(page);
    const cursor = revisionCursor(page?.cursor);
    const rows = await this.prisma.projectRevision.findMany({
      where: {
        projectId,
        project: { workspaceId },
        ...(cursor === null
          ? {}
          : {
              OR: [
                { version: { lt: cursor.revisionVersion } },
                {
                  version: cursor.revisionVersion,
                  id: { lt: cursor.id },
                },
              ],
            }),
      },
      orderBy: [{ version: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const result = pagedResult(rows.map(storedRevision), limit, (revision) => ({
      kind: 'revision' as const,
      version: 1 as const,
      revisionVersion: revision.version,
      id: revision.id,
    }));
    return {
      items: result.items,
      nextCursor: result.next === null ? null : encodeCursor(result.next),
    };
  }

  async listProjectSummaries(
    workspaceId: string,
    page?: CursorInput,
  ): Promise<CursorPage<ProjectSummary>> {
    const limit = pageLimit(page);
    const cursor = summaryCursor(page?.cursor);
    const rows = await this.prisma.project.findMany({
      where: {
        workspaceId,
        ...(cursor === null
          ? {}
          : {
              OR: [
                { updatedAt: { lt: new Date(cursor.updatedAt) } },
                {
                  updatedAt: new Date(cursor.updatedAt),
                  id: { lt: cursor.id },
                },
              ],
            }),
      },
      select: {
        id: true,
        workspaceId: true,
        name: true,
        publicSlug: true,
        draftVersion: true,
        updatedAt: true,
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const result = pagedResult(rows.map(projectSummary), limit, (project) => ({
      kind: 'summary' as const,
      version: 1 as const,
      updatedAt: project.updatedAt.toISOString(),
      id: project.id,
    }));
    return {
      items: result.items,
      nextCursor: result.next === null ? null : encodeCursor(result.next),
    };
  }

  private async withTransaction<T>(
    context: TransactionContext,
    work: (transaction: SiteTransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.transactions[PrismaTransactionClientService](
      context,
      (client) => work(client as SiteTransactionClient),
    );
  }
}
