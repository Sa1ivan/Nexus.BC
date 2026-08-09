import { Inject, Injectable } from '@nestjs/common';
import { PrismaClientService } from '../../../shared/database/prisma.service';
import type { TransactionContext } from '../../../shared/database/transaction-runner';
import {
  PrismaTransactionClientService,
  TransactionRunner,
} from '../../../shared/database/transaction-runner';
import type {
  CreateProjectRecord,
  CursorInput,
  CursorPage,
  ProjectSummary,
  SaveDraftRecord,
  SaveDraftResult,
  SiteRepository,
} from '../application/sites.ports';
import { InvalidSiteCursorError } from '../application/sites-errors';
import type { Project } from '../domain/project';
import type { ProjectRevision } from '../domain/project-revision';
import type { SiteConfigDocument } from '../domain/site-config-v4';

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

interface SitePrismaClient {
  readonly project: {
    findFirst(
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<ProjectRow | null>;
    findMany(
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<SummaryRow[]>;
  };
  readonly projectRevision: {
    findFirst(
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<RevisionRow | null>;
    findMany(
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<RevisionRow[]>;
  };
}

interface SiteTransactionClient extends SitePrismaClient {
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

function siteConfigDocument(value: unknown): SiteConfigDocument {
  if (!isRecord(value)) throw new Error('Stored SiteConfig must be an object');
  return value;
}

function schemaVersion(value: number): 4 {
  if (value !== 4)
    throw new Error('Stored SiteConfig schema version must be 4');
  return value;
}

function storedProject(row: ProjectRow): Project {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    publicSlug: row.publicSlug,
    draft: siteConfigDocument(row.draft),
    draftSchemaVersion: schemaVersion(row.draftSchemaVersion),
    draftVersion: row.draftVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function storedRevision(row: RevisionRow): ProjectRevision {
  return {
    id: row.id,
    projectId: row.projectId,
    operationId: row.operationId,
    version: row.version,
    siteConfig: siteConfigDocument(row.siteConfig),
    schemaVersion: schemaVersion(row.schemaVersion),
    createdAt: row.createdAt,
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
export class PrismaSiteRepository implements SiteRepository {
  constructor(
    @Inject(PrismaClientService)
    private readonly prisma: SitePrismaClient,
    private readonly transactions: TransactionRunner,
  ) {}

  async create(
    context: TransactionContext,
    input: CreateProjectRecord,
  ): Promise<Project> {
    return this.withTransaction(context, async (transaction) => {
      const project = await transaction.project.create({
        data: {
          id: input.id,
          workspaceId: input.workspaceId,
          createOperationId: input.operationId,
          name: input.name,
          publicSlug: input.publicSlug,
          draft: input.siteConfig,
          draftSchemaVersion: 4,
          draftVersion: 1,
        },
      });
      await transaction.projectRevision.create({
        data: {
          projectId: input.id,
          operationId: input.operationId,
          version: 1,
          siteConfig: input.siteConfig,
          schemaVersion: 4,
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

  async saveDraft(
    context: TransactionContext,
    input: SaveDraftRecord,
  ): Promise<SaveDraftResult> {
    return this.withTransaction(context, async (transaction) => {
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
          draft: input.siteConfig,
          draftSchemaVersion: 4,
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
          siteConfig: input.siteConfig,
          schemaVersion: 4,
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
