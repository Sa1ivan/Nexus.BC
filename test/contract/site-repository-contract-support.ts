import { randomUUID } from 'node:crypto';
import type { TransactionContext } from '../../src/shared/database/transaction-runner';

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

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface CursorInput {
  readonly cursor?: string;
  readonly limit?: number;
}

export type SaveDraftResult =
  | { readonly kind: 'saved'; readonly project: StoredProject }
  | { readonly kind: 'not-found' }
  | {
      readonly kind: 'version-conflict';
      readonly currentDraftVersion: number;
    }
  | { readonly kind: 'operation-conflict' };

export interface SiteRepositoryContract {
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

export interface SiteRepositoryDriver {
  readonly repository: SiteRepositoryContract;
  close(): Promise<void>;
  seedWorkspace(workspaceId: string): Promise<void>;
  transact<T>(work: (context: TransactionContext) => Promise<T>): Promise<T>;
}

export type SiteRepositoryDriverFactory = () => Promise<SiteRepositoryDriver>;

function siteConfig(name: string): SiteConfigDocument {
  return {
    id: `site-${name}`,
    schemaVersion: 4,
    name,
    pages: [{ id: `page-${name}`, slug: name, blocks: [] }],
  };
}

function createInput(
  workspaceId: string,
  overrides: Partial<CreateProjectRecord> = {},
): CreateProjectRecord {
  const id = randomUUID();
  return {
    id,
    workspaceId,
    operationId: randomUUID(),
    name: `Project ${id}`,
    publicSlug: `project-${id}`,
    siteConfig: siteConfig(`initial-${id}`),
    ...overrides,
  };
}

async function createProject(
  driver: SiteRepositoryDriver,
  workspaceId: string,
  overrides: Partial<CreateProjectRecord> = {},
): Promise<{
  readonly input: CreateProjectRecord;
  readonly project: StoredProject;
}> {
  const input = createInput(workspaceId, overrides);
  const project = await driver.transact((context) =>
    driver.repository.create(context, input),
  );
  return { input, project };
}

export function defineSiteRepositoryContract(
  adapterName: string,
  createDriver: SiteRepositoryDriverFactory,
): void {
  describe(`${adapterName} site repository contract`, () => {
    let driver: SiteRepositoryDriver;
    let workspaceId: string;
    let otherWorkspaceId: string;

    beforeEach(async () => {
      driver = await createDriver();
      workspaceId = randomUUID();
      otherWorkspaceId = randomUUID();
      await driver.seedWorkspace(workspaceId);
      await driver.seedWorkspace(otherWorkspaceId);
    });

    afterEach(async () => {
      if (driver !== undefined) await driver.close();
    });

    it('creates version one with one immutable initial revision', async () => {
      const { input, project } = await createProject(driver, workspaceId);

      expect(project).toMatchObject({
        id: input.id,
        workspaceId,
        name: input.name,
        publicSlug: input.publicSlug,
        draft: input.siteConfig,
        draftSchemaVersion: 4,
        draftVersion: 1,
      });
      expect(project.createdAt).toBeInstanceOf(Date);
      expect(project.updatedAt).toBeInstanceOf(Date);

      const revisions = await driver.repository.listRevisions(
        workspaceId,
        project.id,
      );
      expect(revisions).toMatchObject({ nextCursor: null });
      expect(revisions.items).toHaveLength(1);
      expect(revisions.items[0]).toMatchObject({
        projectId: project.id,
        operationId: input.operationId,
        version: 1,
        siteConfig: input.siteConfig,
        schemaVersion: 4,
      });
    });

    it('hides reads, revisions, summaries, and writes from another workspace', async () => {
      const { project } = await createProject(driver, workspaceId);

      await expect(
        driver.repository.findForWorkspace(otherWorkspaceId, project.id),
      ).resolves.toBeNull();
      await expect(
        driver.repository.listRevisions(otherWorkspaceId, project.id),
      ).resolves.toEqual({ items: [], nextCursor: null });
      await expect(
        driver.repository.listProjectSummaries(otherWorkspaceId),
      ).resolves.toEqual({ items: [], nextCursor: null });

      const saveResult = await driver.transact((context) =>
        driver.repository.saveDraft(context, {
          workspaceId: otherWorkspaceId,
          projectId: project.id,
          operationId: randomUUID(),
          expectedDraftVersion: 1,
          siteConfig: siteConfig('foreign-write'),
        }),
      );
      expect(saveResult).toEqual({ kind: 'not-found' });

      await expect(
        driver.repository.findForWorkspace(workspaceId, project.id),
      ).resolves.toMatchObject({ draftVersion: 1 });
    });

    it('enforces create operation uniqueness within one workspace only', async () => {
      const operationId = randomUUID();
      await createProject(driver, workspaceId, { operationId });

      await expect(
        createProject(driver, workspaceId, { operationId }),
      ).rejects.toThrow(/operation|unique/iu);
      await expect(
        createProject(driver, otherWorkspaceId, { operationId }),
      ).resolves.toMatchObject({
        project: { workspaceId: otherWorkspaceId, draftVersion: 1 },
      });
    });

    it('atomically increments the draft version and keeps prior revisions immutable', async () => {
      const { input, project } = await createProject(driver, workspaceId);
      const secondDocument = siteConfig('second');
      const operationId = randomUUID();

      const result = await driver.transact((context) =>
        driver.repository.saveDraft(context, {
          workspaceId,
          projectId: project.id,
          operationId,
          expectedDraftVersion: 1,
          siteConfig: secondDocument,
        }),
      );
      expect(result).toMatchObject({
        kind: 'saved',
        project: {
          id: project.id,
          draft: secondDocument,
          draftSchemaVersion: 4,
          draftVersion: 2,
          publicSlug: input.publicSlug,
        },
      });

      const revisions = await driver.repository.listRevisions(
        workspaceId,
        project.id,
      );
      expect(revisions.items.map(({ version }) => version)).toEqual([2, 1]);
      expect(revisions.items[0]).toMatchObject({
        operationId,
        siteConfig: secondDocument,
      });
      expect(revisions.items[1]).toMatchObject({
        operationId: input.operationId,
        siteConfig: input.siteConfig,
      });
    });

    it('rejects a repeated revision operation without mutating the project', async () => {
      const { project } = await createProject(driver, workspaceId);
      const operationId = randomUUID();

      await expect(
        driver.transact((context) =>
          driver.repository.saveDraft(context, {
            workspaceId,
            projectId: project.id,
            operationId,
            expectedDraftVersion: 1,
            siteConfig: siteConfig('accepted'),
          }),
        ),
      ).resolves.toMatchObject({ kind: 'saved' });

      await expect(
        driver.transact((context) =>
          driver.repository.saveDraft(context, {
            workspaceId,
            projectId: project.id,
            operationId,
            expectedDraftVersion: 2,
            siteConfig: siteConfig('reused-operation'),
          }),
        ),
      ).resolves.toEqual({ kind: 'operation-conflict' });
      await expect(
        driver.repository.findForWorkspace(workspaceId, project.id),
      ).resolves.toMatchObject({
        draftVersion: 2,
        draft: siteConfig('accepted'),
      });
    });

    it('allows exactly one different-key save for the same expected version', async () => {
      const { project } = await createProject(driver, workspaceId);
      const results = await Promise.all([
        driver.transact((context) =>
          driver.repository.saveDraft(context, {
            workspaceId,
            projectId: project.id,
            operationId: randomUUID(),
            expectedDraftVersion: 1,
            siteConfig: siteConfig('racer-a'),
          }),
        ),
        driver.transact((context) =>
          driver.repository.saveDraft(context, {
            workspaceId,
            projectId: project.id,
            operationId: randomUUID(),
            expectedDraftVersion: 1,
            siteConfig: siteConfig('racer-b'),
          }),
        ),
      ]);

      expect(results.filter(({ kind }) => kind === 'saved')).toHaveLength(1);
      expect(results.filter(({ kind }) => kind === 'version-conflict')).toEqual(
        [{ kind: 'version-conflict', currentDraftVersion: 2 }],
      );
      const revisions = await driver.repository.listRevisions(
        workspaceId,
        project.id,
      );
      expect(revisions.items).toHaveLength(2);
    });

    it('paginates summaries and revisions with bounded opaque cursors', async () => {
      const first = await createProject(driver, workspaceId, {
        name: 'First',
      });
      const second = await createProject(driver, workspaceId, {
        name: 'Second',
      });
      await driver.transact((context) =>
        driver.repository.saveDraft(context, {
          workspaceId,
          projectId: second.project.id,
          operationId: randomUUID(),
          expectedDraftVersion: 1,
          siteConfig: siteConfig('second-v2'),
        }),
      );

      const summaryPageOne = await driver.repository.listProjectSummaries(
        workspaceId,
        { limit: 1 },
      );
      expect(summaryPageOne.items).toHaveLength(1);
      expect(summaryPageOne.nextCursor).toEqual(expect.any(String));
      const summaryPageTwo = await driver.repository.listProjectSummaries(
        workspaceId,
        { cursor: summaryPageOne.nextCursor as string, limit: 1 },
      );
      expect(summaryPageTwo.items).toHaveLength(1);
      expect(
        new Set([summaryPageOne.items[0]?.id, summaryPageTwo.items[0]?.id]),
      ).toEqual(new Set([first.project.id, second.project.id]));

      const revisionPageOne = await driver.repository.listRevisions(
        workspaceId,
        second.project.id,
        { limit: 1 },
      );
      expect(revisionPageOne.items.map(({ version }) => version)).toEqual([2]);
      expect(revisionPageOne.nextCursor).toEqual(expect.any(String));
      const revisionPageTwo = await driver.repository.listRevisions(
        workspaceId,
        second.project.id,
        { cursor: revisionPageOne.nextCursor as string, limit: 1 },
      );
      expect(revisionPageTwo.items.map(({ version }) => version)).toEqual([1]);

      await expect(
        Promise.resolve().then(() =>
          driver.repository.listProjectSummaries(workspaceId, { limit: 101 }),
        ),
      ).rejects.toThrow('limit');
      await expect(
        Promise.resolve().then(() =>
          driver.repository.listRevisions(workspaceId, second.project.id, {
            limit: 101,
          }),
        ),
      ).rejects.toThrow('limit');
    });
  });
}
