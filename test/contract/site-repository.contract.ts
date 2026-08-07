import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { Pool } from 'pg';
import { PrismaModule } from '../../src/shared/database/prisma.module';
import {
  TransactionRunner,
  type TransactionContext,
} from '../../src/shared/database/transaction-runner';
import {
  type CreateProjectRecord,
  type CursorInput,
  type CursorPage,
  defineSiteRepositoryContract,
  type ProjectSummary,
  type SaveDraftRecord,
  type SaveDraftResult,
  type SiteConfigDocument,
  type SiteRepositoryContract,
  type SiteRepositoryDriver,
  type StoredProject,
  type StoredProjectRevision,
} from './site-repository-contract-support';

interface MutableProject {
  id: string;
  workspaceId: string;
  name: string;
  publicSlug: string;
  draft: SiteConfigDocument;
  draftSchemaVersion: 4;
  draftVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

function cloneDocument(value: SiteConfigDocument): SiteConfigDocument {
  return structuredClone(value);
}

function cloneProject(project: MutableProject): StoredProject {
  return {
    ...project,
    draft: cloneDocument(project.draft),
    createdAt: new Date(project.createdAt),
    updatedAt: new Date(project.updatedAt),
  };
}

function cloneRevision(revision: StoredProjectRevision): StoredProjectRevision {
  return {
    ...revision,
    siteConfig: cloneDocument(revision.siteConfig),
    createdAt: new Date(revision.createdAt),
  };
}

function pageLimit(page: CursorInput | undefined): number {
  const limit = page?.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('page limit must be between 1 and 100');
  }
  return limit;
}

function cursorOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const decoded = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isSafeInteger(decoded) || decoded < 0) {
    throw new Error('invalid cursor');
  }
  return decoded;
}

function paginate<T>(
  values: readonly T[],
  page: CursorInput | undefined,
): CursorPage<T> {
  const limit = pageLimit(page);
  const offset = cursorOffset(page?.cursor);
  const items = values.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return {
    items,
    nextCursor:
      nextOffset < values.length
        ? Buffer.from(String(nextOffset), 'utf8').toString('base64url')
        : null,
  };
}

class InMemorySiteRepository implements SiteRepositoryContract {
  private readonly workspaces = new Set<string>();
  private readonly projects = new Map<string, MutableProject>();
  private readonly revisions = new Map<string, StoredProjectRevision[]>();
  private logicalTime = Date.UTC(2026, 7, 7, 12, 0, 0);

  seedWorkspace(workspaceId: string): void {
    this.workspaces.add(workspaceId);
  }

  create(
    _context: TransactionContext,
    input: CreateProjectRecord,
  ): Promise<StoredProject> {
    if (!this.workspaces.has(input.workspaceId)) {
      return Promise.reject(new Error('workspace does not exist'));
    }
    if (
      [...this.projects.values()].some(
        (project) =>
          project.publicSlug === input.publicSlug ||
          (project.workspaceId === input.workspaceId &&
            this.revisions
              .get(project.id)
              ?.some(({ operationId }) => operationId === input.operationId)),
      )
    ) {
      return Promise.reject(new Error('project operation is not unique'));
    }
    const now = this.nextDate();
    const project: MutableProject = {
      id: input.id,
      workspaceId: input.workspaceId,
      name: input.name,
      publicSlug: input.publicSlug,
      draft: cloneDocument(input.siteConfig),
      draftSchemaVersion: 4,
      draftVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(project.id, project);
    this.revisions.set(project.id, [
      {
        id: randomUUID(),
        projectId: project.id,
        operationId: input.operationId,
        version: 1,
        siteConfig: cloneDocument(input.siteConfig),
        schemaVersion: 4,
        createdAt: now,
      },
    ]);
    return Promise.resolve(cloneProject(project));
  }

  findForWorkspace(
    workspaceId: string,
    projectId: string,
  ): Promise<StoredProject | null> {
    const project = this.projects.get(projectId);
    return Promise.resolve(
      project?.workspaceId === workspaceId ? cloneProject(project) : null,
    );
  }

  saveDraft(
    _context: TransactionContext,
    input: SaveDraftRecord,
  ): Promise<SaveDraftResult> {
    const project = this.projects.get(input.projectId);
    if (project?.workspaceId !== input.workspaceId) {
      return Promise.resolve({ kind: 'not-found' });
    }
    const revisions = this.revisions.get(project.id) ?? [];
    if (
      revisions.some(({ operationId }) => operationId === input.operationId)
    ) {
      return Promise.resolve({ kind: 'operation-conflict' });
    }
    if (project.draftVersion !== input.expectedDraftVersion) {
      return Promise.resolve({
        kind: 'version-conflict',
        currentDraftVersion: project.draftVersion,
      });
    }
    const now = this.nextDate();
    project.draft = cloneDocument(input.siteConfig);
    project.draftVersion += 1;
    project.updatedAt = now;
    revisions.push({
      id: randomUUID(),
      projectId: project.id,
      operationId: input.operationId,
      version: project.draftVersion,
      siteConfig: cloneDocument(input.siteConfig),
      schemaVersion: 4,
      createdAt: now,
    });
    this.revisions.set(project.id, revisions);
    return Promise.resolve({ kind: 'saved', project: cloneProject(project) });
  }

  listRevisions(
    workspaceId: string,
    projectId: string,
    page?: CursorInput,
  ): Promise<CursorPage<StoredProjectRevision>> {
    const project = this.projects.get(projectId);
    if (project?.workspaceId !== workspaceId) {
      return Promise.resolve({ items: [], nextCursor: null });
    }
    const revisions = [...(this.revisions.get(projectId) ?? [])]
      .sort((left, right) => right.version - left.version)
      .map(cloneRevision);
    return Promise.resolve(paginate(revisions, page));
  }

  listProjectSummaries(
    workspaceId: string,
    page?: CursorInput,
  ): Promise<CursorPage<ProjectSummary>> {
    const summaries = [...this.projects.values()]
      .filter((project) => project.workspaceId === workspaceId)
      .sort(
        (left, right) =>
          right.updatedAt.getTime() - left.updatedAt.getTime() ||
          right.id.localeCompare(left.id),
      )
      .map((project): ProjectSummary => ({
        id: project.id,
        workspaceId: project.workspaceId,
        name: project.name,
        publicSlug: project.publicSlug,
        draftVersion: project.draftVersion,
        updatedAt: new Date(project.updatedAt),
      }));
    return Promise.resolve(paginate(summaries, page));
  }

  private nextDate(): Date {
    this.logicalTime += 1;
    return new Date(this.logicalTime);
  }
}

function inMemoryDriver(): Promise<SiteRepositoryDriver> {
  const repository = new InMemorySiteRepository();
  return Promise.resolve({
    repository,
    seedWorkspace: (workspaceId) => {
      repository.seedWorkspace(workspaceId);
      return Promise.resolve();
    },
    transact: (work) => work(Object.freeze({}) as TransactionContext),
    close: () => Promise.resolve(),
  });
}

type SiteRepositoryConstructor = new (...arguments_: never[]) => object;

interface PrismaRepositoryModule {
  readonly PrismaSiteRepository?: SiteRepositoryConstructor;
}

function missingPrismaRepository(): SiteRepositoryContract {
  const missing = (): never => {
    throw new Error('PrismaSiteRepository is not implemented');
  };
  return {
    create: missing,
    findForWorkspace: missing,
    saveDraft: missing,
    listRevisions: missing,
    listProjectSummaries: missing,
  };
}

function loadPrismaRepository(): SiteRepositoryConstructor | undefined {
  const modulePath =
    '../../src/modules/sites/infrastructure/prisma-site.repository';
  try {
    const loaded = jest.requireActual<PrismaRepositoryModule>(modulePath);
    return loaded.PrismaSiteRepository;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Cannot find module')) return undefined;
    throw error;
  }
}

async function prismaDriver(): Promise<SiteRepositoryDriver> {
  const repositoryConstructor = loadPrismaRepository();
  if (repositoryConstructor === undefined) {
    return {
      repository: missingPrismaRepository(),
      seedWorkspace: () => Promise.resolve(),
      transact: (work) => work(Object.freeze({}) as TransactionContext),
      close: () => Promise.resolve(),
    };
  }

  const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
  await pool.query('DELETE FROM "IdempotencyRecord"');
  await pool.query('DELETE FROM "Project"');
  await pool.query('DELETE FROM "Membership"');
  await pool.query('DELETE FROM "Workspace"');
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [PrismaModule],
    providers: [repositoryConstructor],
  }).compile();
  const repository = moduleFixture.get<SiteRepositoryContract>(
    repositoryConstructor,
  );
  const transactions = moduleFixture.get(TransactionRunner);

  return {
    repository,
    seedWorkspace: async (workspaceId) => {
      await pool.query(
        `INSERT INTO "Workspace" ("id", "name", "createdAt", "updatedAt")
         VALUES ($1, 'Repository contract workspace', now(), now())`,
        [workspaceId],
      );
    },
    transact: (work) => transactions.run(work),
    close: async () => {
      await moduleFixture.close();
      await pool.end();
    },
  };
}

function independentLockId(
  scope: string,
  operation: string,
  key: string,
): bigint {
  const chunks: Buffer[] = [Buffer.from('nexus-idempotency-lock-v1\0', 'utf8')];
  for (const value of [scope, operation, key]) {
    const bytes = Buffer.from(value, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.byteLength);
    chunks.push(length, bytes);
  }
  return createHash('sha256')
    .update(Buffer.concat(chunks))
    .digest()
    .readBigInt64BE(0);
}

describe('idempotency hashing and advisory-lock contracts', () => {
  it.each([
    {
      scope: 'workspace:alpha',
      operation: 'CREATE_PROJECT',
      key: '00000000-0000-4000-8000-000000000001',
      expected: 1618010971938538626n,
    },
    {
      scope: 'project:β',
      operation: 'SAVE_DRAFT',
      key: 'retry-1',
      expected: 1978625679360959276n,
    },
  ])(
    'matches the frozen $operation vector with independent and production implementations',
    ({ scope, operation, key, expected }) => {
      expect(independentLockId(scope, operation, key)).toBe(expected);
      const modulePath = '../../src/shared/idempotency/idempotency-lock';
      const loaded = jest.requireActual<{
        readonly idempotencyAdvisoryLockId?: (
          value: Readonly<{
            scope: string;
            operation: string;
            key: string;
          }>,
        ) => bigint;
      }>(modulePath);
      expect(
        loaded.idempotencyAdvisoryLockId?.({ scope, operation, key }),
      ).toBe(expected);
    },
  );

  it('canonicalizes semantic JSON, supports retained keys, and rejects unknown fingerprint versions', () => {
    const modulePath = '../../src/shared/idempotency/request-fingerprint';
    const loaded = jest.requireActual<{
      readonly createRequestFingerprint?: (
        request: unknown,
        activeVersion: number,
        keyring: ReadonlyMap<number, Buffer>,
      ) => string;
      readonly verifyRequestFingerprint?: (
        fingerprint: string,
        request: unknown,
        keyring: ReadonlyMap<number, Buffer>,
      ) => boolean;
    }>(modulePath);
    const keys = new Map([
      [1, Buffer.alloc(32, 1)],
      [2, Buffer.alloc(32, 2)],
    ]);
    const left = {
      operation: 'SAVE_DRAFT',
      body: {
        expectedDraftVersion: 1,
        siteConfig: { name: 'Nexus', pages: [] },
      },
    };
    const sameSemanticValue = {
      body: {
        siteConfig: { pages: [], name: 'Nexus' },
        expectedDraftVersion: 1,
      },
      operation: 'SAVE_DRAFT',
    };
    const changedValue = {
      ...sameSemanticValue,
      body: { ...sameSemanticValue.body, expectedDraftVersion: 2 },
    };

    const fingerprint = loaded.createRequestFingerprint?.(left, 1, keys);
    expect(fingerprint).toMatch(/^hmac-sha256:v1:[0-9a-f]{64}$/u);
    expect(
      loaded.verifyRequestFingerprint?.(
        fingerprint as string,
        sameSemanticValue,
        keys,
      ),
    ).toBe(true);
    expect(
      loaded.verifyRequestFingerprint?.(
        fingerprint as string,
        changedValue,
        keys,
      ),
    ).toBe(false);
    expect(
      loaded.verifyRequestFingerprint?.(
        `hmac-sha256:v99:${'a'.repeat(64)}`,
        left,
        keys,
      ),
    ).toBe(false);
    expect(
      loaded.verifyRequestFingerprint?.(`${'a'.repeat(64)}`, left, keys),
    ).toBe(false);

    const rotated = loaded.createRequestFingerprint?.(left, 2, keys);
    expect(rotated).toMatch(/^hmac-sha256:v2:[0-9a-f]{64}$/u);
    expect(
      loaded.verifyRequestFingerprint?.(
        fingerprint as string,
        sameSemanticValue,
        keys,
      ),
    ).toBe(true);
  });

  it('uses a constant-time digest comparison in the production verifier', () => {
    const source = readFileSync(
      resolve('src/shared/idempotency/request-fingerprint.ts'),
      'utf8',
    );
    expect(source).toMatch(/\btimingSafeEqual\b/u);
    expect(source).not.toMatch(/(?:digest|expected|supplied)\s*===/u);
  });

  it('rejects lone UTF-16 surrogates that RFC 8785 excludes from canonical JSON', () => {
    const modulePath = '../../src/shared/idempotency/request-fingerprint';
    const loaded = jest.requireActual<{
      readonly createRequestFingerprint?: (
        request: unknown,
        activeVersion: number,
        keyring: ReadonlyMap<number, Buffer>,
      ) => string;
    }>(modulePath);
    const keys = new Map([[1, Buffer.alloc(32, 1)]]);

    expect(() =>
      loaded.createRequestFingerprint?.({ value: '\ud800' }, 1, keys),
    ).toThrow(/unicode|surrogate/iu);
    expect(() =>
      loaded.createRequestFingerprint?.({ ['\udc00']: true }, 1, keys),
    ).toThrow(/unicode|surrogate/iu);
  });
});

defineSiteRepositoryContract('in-memory', inMemoryDriver);
defineSiteRepositoryContract('Prisma', prismaDriver);
