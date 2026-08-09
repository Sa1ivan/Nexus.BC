import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { ActivateRelease } from '../../src/modules/sites/application/activate-release';
import { PublishProject } from '../../src/modules/sites/application/publish-project';
import { SaveProjectDraft } from '../../src/modules/sites/application/save-project-draft';
import { SitesApplicationError } from '../../src/modules/sites/application/sites-errors';
import {
  AUDIT_WRITER,
  type AuditWriter,
} from '../../src/shared/audit/audit-writer';
import { TransactionRunner } from '../../src/shared/database/transaction-runner';

interface FixtureIdentity {
  readonly userId: string;
  readonly workspaceId: string;
  readonly projectId: string;
}

interface ReleaseFixture {
  readonly releaseId: string;
  readonly version: number;
}

interface StoredIdempotency {
  readonly httpStatus: number;
  readonly key: string;
  readonly operation: string;
  readonly resourceId: string | null;
  readonly responseBody: Record<string, unknown>;
  readonly scope: string;
}

interface SiteState {
  readonly activeReleaseId: string | null;
  readonly draftVersion: number;
  readonly releases: number;
  readonly revisions: number;
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fixture(name: string): Record<string, unknown> {
  const value: unknown = JSON.parse(
    readFileSync(resolve('contracts/site-config/fixtures', name), 'utf8'),
  );
  if (!isRecord(value)) throw new Error(`Fixture ${name} must be an object`);
  return value;
}

function projectScope(identity: FixtureIdentity): string {
  return `workspace:${identity.workspaceId}:project:${identity.projectId}`;
}

function fixtureIdentity(base: number): FixtureIdentity {
  return {
    userId: uuid(base),
    workspaceId: uuid(base + 1),
    projectId: uuid(base + 2),
  };
}

async function removeIdentity(
  pool: Pool,
  identity: FixtureIdentity,
): Promise<void> {
  await pool.query(
    `DELETE FROM "IdempotencyRecord"
      WHERE "scope" = $1 OR "resourceId" = $2`,
    [projectScope(identity), identity.projectId],
  );
  await pool.query('DELETE FROM "ActiveRelease" WHERE "projectId" = $1', [
    identity.projectId,
  ]);
  await pool.query('DELETE FROM "Release" WHERE "projectId" = $1', [
    identity.projectId,
  ]);
  await pool.query('DELETE FROM "ProjectRevision" WHERE "projectId" = $1', [
    identity.projectId,
  ]);
  await pool.query('DELETE FROM "Project" WHERE "id" = $1', [
    identity.projectId,
  ]);
  await pool.query(
    'DELETE FROM "Membership" WHERE "workspaceId" = $1 AND "userId" = $2',
    [identity.workspaceId, identity.userId],
  );
  await pool.query('DELETE FROM "Workspace" WHERE "id" = $1', [
    identity.workspaceId,
  ]);
  await pool.query('DELETE FROM "User" WHERE "id" = $1', [identity.userId]);
}

async function seedIdentity(
  pool: Pool,
  base: number,
  identity = fixtureIdentity(base),
): Promise<FixtureIdentity> {
  await removeIdentity(pool, identity);
  await pool.query(
    `INSERT INTO "User"
       ("id", "email", "passwordHash", "emailVerifiedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, 'release-application-test', now(), now(), now())`,
    [identity.userId, `release-${base}@example.test`],
  );
  await pool.query(
    `INSERT INTO "Workspace" ("id", "name", "createdAt", "updatedAt")
     VALUES ($1, $2, now(), now())`,
    [identity.workspaceId, `Release workspace ${base}`],
  );
  await pool.query(
    `INSERT INTO "Membership"
       ("workspaceId", "userId", "role", "createdAt", "updatedAt")
     VALUES ($1, $2, 'OWNER', now(), now())`,
    [identity.workspaceId, identity.userId],
  );
  const initialConfig = fixture('v4-minimal-valid.json');
  await pool.query(
    `INSERT INTO "Project"
       ("id", "workspaceId", "createOperationId", "name", "publicSlug",
        "draft", "draftSchemaVersion", "draftVersion", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 4, 1, now(), now())`,
    [
      identity.projectId,
      identity.workspaceId,
      `CREATE_PROJECT:${uuid(base + 3)}`,
      `Release project ${base}`,
      `release-project-${base}`,
      JSON.stringify(initialConfig),
    ],
  );
  await pool.query(
    `INSERT INTO "ProjectRevision"
       ("id", "projectId", "operationId", "version", "siteConfig", "schemaVersion")
     VALUES ($1, $2, $3, 1, $4::jsonb, 4)`,
    [
      uuid(base + 4),
      identity.projectId,
      `CREATE_PROJECT:${uuid(base + 3)}`,
      JSON.stringify(initialConfig),
    ],
  );
  return identity;
}

async function seedRelease(
  pool: Pool,
  identity: FixtureIdentity,
  releaseId: string,
  version: number,
  active = false,
): Promise<ReleaseFixture> {
  await pool.query(
    `INSERT INTO "Release"
       ("id", "projectId", "operationId", "version", "siteConfig", "schemaVersion")
     VALUES ($1, $2, $3, $4, $5::jsonb, 4)`,
    [
      releaseId,
      identity.projectId,
      `PUBLISH_PROJECT:${releaseId}`,
      version,
      JSON.stringify(fixture('v4-minimal-valid.json')),
    ],
  );
  if (active) {
    await pool.query(
      `INSERT INTO "ActiveRelease" ("projectId", "releaseId")
       VALUES ($1, $2)
       ON CONFLICT ("projectId") DO UPDATE SET "releaseId" = EXCLUDED."releaseId"`,
      [identity.projectId, releaseId],
    );
  }
  return { releaseId, version };
}

async function storedIdempotency(
  pool: Pool,
  identity: FixtureIdentity,
  operation: 'PUBLISH_PROJECT' | 'ACTIVATE_RELEASE',
  operationId: string,
): Promise<StoredIdempotency | undefined> {
  const result = await pool.query<StoredIdempotency>(
    `SELECT "scope", "operation", "key", "httpStatus", "responseBody", "resourceId"
       FROM "IdempotencyRecord"
      WHERE "scope" = $1 AND "operation" = $2 AND "key" = $3`,
    [projectScope(identity), operation, operationId],
  );
  return result.rows[0];
}

async function replaceStoredIdempotencyTuple(
  pool: Pool,
  identity: FixtureIdentity,
  operation: 'PUBLISH_PROJECT' | 'ACTIVATE_RELEASE',
  operationId: string,
  tuple: Pick<StoredIdempotency, 'httpStatus' | 'resourceId' | 'responseBody'>,
): Promise<void> {
  await pool.query(
    `UPDATE "IdempotencyRecord"
        SET "httpStatus" = $4, "resourceId" = $5, "responseBody" = $6::jsonb
      WHERE "scope" = $1 AND "operation" = $2 AND "key" = $3`,
    [
      projectScope(identity),
      operation,
      operationId,
      tuple.httpStatus,
      tuple.resourceId,
      JSON.stringify(tuple.responseBody),
    ],
  );
}

async function siteState(
  pool: Pool,
  identity: FixtureIdentity,
): Promise<SiteState> {
  const result = await pool.query<{
    activeReleaseId: string | null;
    draftVersion: number;
    releases: string;
    revisions: string;
  }>(
    `SELECT project."draftVersion",
            (SELECT COUNT(*) FROM "ProjectRevision" revision
              WHERE revision."projectId" = project."id") AS revisions,
            (SELECT COUNT(*) FROM "Release" release
              WHERE release."projectId" = project."id") AS releases,
            (SELECT active."releaseId" FROM "ActiveRelease" active
              WHERE active."projectId" = project."id") AS "activeReleaseId"
       FROM "Project" project
      WHERE project."id" = $1 AND project."workspaceId" = $2`,
    [identity.projectId, identity.workspaceId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Expected seeded project state');
  return {
    activeReleaseId: row.activeReleaseId,
    draftVersion: row.draftVersion,
    releases: Number(row.releases),
    revisions: Number(row.revisions),
  };
}

async function auditSequence(pool: Pool): Promise<bigint> {
  const result = await pool.query<{ nextValue: string }>(
    'SELECT "nextValue"::text AS "nextValue" FROM "AuditSequence" WHERE "id" = 1',
  );
  const value = result.rows[0]?.nextValue;
  if (value === undefined) throw new Error('Expected AuditSequence singleton');
  return BigInt(value);
}

describe('publish and release activation application transactions', () => {
  let app: INestApplication<App>;
  let pool: Pool;
  let publishProject: PublishProject;
  let activateRelease: ActivateRelease;
  let saveDraft: SaveProjectDraft;
  let auditWriter: AuditWriter;
  let transactions: TransactionRunner;
  let identity: FixtureIdentity;
  let cleanupIdentity: FixtureIdentity | undefined;
  let testAuditSequence: bigint;
  let fixtureOrdinal = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    publishProject = app.get(PublishProject);
    activateRelease = app.get(ActivateRelease);
    saveDraft = app.get(SaveProjectDraft);
    auditWriter = app.get<AuditWriter>(AUDIT_WRITER);
    transactions = app.get(TransactionRunner);
  });

  beforeEach(async () => {
    cleanupIdentity = undefined;
    fixtureOrdinal += 1;
    const base = 0x530000 + fixtureOrdinal * 0x100;
    const nextIdentity = fixtureIdentity(base);
    cleanupIdentity = nextIdentity;
    identity = await seedIdentity(pool, base, nextIdentity);
    testAuditSequence = await auditSequence(pool);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    const cleanup = cleanupIdentity;
    cleanupIdentity = undefined;
    if (cleanup !== undefined) await removeIdentity(pool, cleanup);
  });

  afterAll(async () => {
    await pool?.end();
    await app?.close();
  });

  it('publishes project, revision, release, activation, audit, and replay state atomically', async () => {
    const operationId = uuid(0x510001);
    const requestId = uuid(0x510002);
    const siteConfig = fixture('v4-bundled-dot-images-valid.json');

    const result = await publishProject.execute({
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      userId: identity.userId,
      operationId,
      requestId,
      expectedDraftVersion: 1,
      siteConfig,
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(typeof result.releaseId).toBe('string');
    expect(result).toEqual({
      releaseId: result.releaseId,
      projectId: identity.projectId,
      version: 2,
      schemaVersion: 4,
    });
    await expect(siteState(pool, identity)).resolves.toEqual({
      activeReleaseId: result.releaseId,
      draftVersion: 2,
      releases: 1,
      revisions: 2,
    });
    const business = await pool.query<{
      draft: unknown;
      draftSchemaVersion: number;
      releaseConfig: unknown;
      releaseOperationId: string;
      revisionConfig: unknown;
      revisionOperationId: string;
      revisionSchemaVersion: number;
    }>(
      `SELECT project."draft",
              project."draftSchemaVersion" AS "draftSchemaVersion",
              revision."siteConfig" AS "revisionConfig",
              revision."operationId" AS "revisionOperationId",
              revision."schemaVersion" AS "revisionSchemaVersion",
              release."siteConfig" AS "releaseConfig",
              release."operationId" AS "releaseOperationId"
         FROM "Project" project
         JOIN "ProjectRevision" revision
           ON revision."projectId" = project."id" AND revision."version" = 2
         JOIN "Release" release
           ON release."projectId" = project."id" AND release."version" = 2
        WHERE project."id" = $1`,
      [identity.projectId],
    );
    expect(business.rows[0]).toEqual({
      draft: business.rows[0]?.draft,
      draftSchemaVersion: 4,
      releaseConfig: business.rows[0]?.draft,
      releaseOperationId: `PUBLISH_PROJECT:${operationId}`,
      revisionConfig: business.rows[0]?.draft,
      revisionOperationId: `PUBLISH_PROJECT:${operationId}`,
      revisionSchemaVersion: 4,
    });
    expect(JSON.stringify(business.rows[0]?.draft)).not.toContain('./images/');

    const audit = await pool.query<{
      action: string;
      actorUserId: string;
      metadata: unknown;
      requestId: string;
      resourceId: string;
      resourceType: string;
      workspaceId: string;
    }>(
      `SELECT "workspaceId", "actorUserId", "action", "resourceType",
              "resourceId", "metadata", "requestId"
         FROM "AuditEvent"
        WHERE "resourceId" = $1 AND "action" = 'PROJECT_PUBLISHED'`,
      [result.releaseId],
    );
    expect(audit.rows).toEqual([
      {
        workspaceId: identity.workspaceId,
        actorUserId: identity.userId,
        action: 'PROJECT_PUBLISHED',
        resourceType: 'Release',
        resourceId: result.releaseId,
        metadata: { projectId: identity.projectId, version: 2 },
        requestId,
      },
    ]);
    const replay = await storedIdempotency(
      pool,
      identity,
      'PUBLISH_PROJECT',
      operationId,
    );
    expect(replay).toEqual({
      scope: projectScope(identity),
      operation: 'PUBLISH_PROJECT',
      key: operationId,
      httpStatus: 200,
      responseBody: result,
      resourceId: result.releaseId,
    });
    expect(JSON.stringify(replay?.responseBody)).not.toContain('siteConfig');
  });

  it('stores a stale publish conflict without a business or audit write', async () => {
    const operationId = uuid(0x510011);
    const input = {
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      userId: identity.userId,
      operationId,
      requestId: uuid(0x510012),
      expectedDraftVersion: 0,
      siteConfig: fixture('v4-full-valid.json'),
    } as const;
    await expect(publishProject.execute(input)).rejects.toMatchObject({
      code: 'PROJECT_VERSION_CONFLICT',
      currentDraftVersion: 1,
    });

    await expect(siteState(pool, identity)).resolves.toEqual({
      activeReleaseId: null,
      draftVersion: 1,
      releases: 0,
      revisions: 1,
    });
    const storedConflict = await storedIdempotency(
      pool,
      identity,
      'PUBLISH_PROJECT',
      operationId,
    );
    expect(storedConflict).toMatchObject({
      httpStatus: 409,
      responseBody: {
        code: 'PROJECT_VERSION_CONFLICT',
        projectId: identity.projectId,
        workspaceId: identity.workspaceId,
        draftVersion: 1,
      },
    });
    await saveDraft.execute({
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      userId: identity.userId,
      operationId: uuid(0x510013),
      expectedDraftVersion: 1,
      siteConfig: fixture('v4-bundled-images-valid.json'),
    });
    await expect(publishProject.execute(input)).rejects.toMatchObject({
      code: 'PROJECT_VERSION_CONFLICT',
      currentDraftVersion: 1,
    });
    await expect(
      storedIdempotency(pool, identity, 'PUBLISH_PROJECT', operationId),
    ).resolves.toEqual(storedConflict);
    await expect(siteState(pool, identity)).resolves.toEqual({
      activeReleaseId: null,
      draftVersion: 2,
      releases: 0,
      revisions: 2,
    });
    const audits = await pool.query(
      `SELECT 1 FROM "AuditEvent"
        WHERE "metadata"->>'projectId' = $1 AND "action" = 'PROJECT_PUBLISHED'
          AND "sequence" >= $2::bigint`,
      [identity.projectId, testAuditSequence.toString()],
    );
    expect(audits.rows).toHaveLength(0);

    if (storedConflict === undefined) {
      throw new Error('Expected stored publish conflict');
    }
    await replaceStoredIdempotencyTuple(
      pool,
      identity,
      'PUBLISH_PROJECT',
      operationId,
      { ...storedConflict, resourceId: null },
    );
    await expect(publishProject.execute(input)).rejects.toThrow(
      'Stored idempotency publish result is invalid',
    );
  });

  it('replays the original immutable release after a later draft save', async () => {
    const operationId = uuid(0x510021);
    const input = {
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      userId: identity.userId,
      operationId,
      requestId: uuid(0x510022),
      expectedDraftVersion: 1,
      siteConfig: fixture('v4-full-valid.json'),
    } as const;
    const published = await publishProject.execute(input);
    await saveDraft.execute({
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      userId: identity.userId,
      operationId: uuid(0x510023),
      expectedDraftVersion: 2,
      siteConfig: fixture('v4-bundled-images-valid.json'),
    });

    const replayed = await publishProject.execute(input);

    expect(replayed).toEqual(published);
    expect(Object.isFrozen(replayed)).toBe(true);
    await expect(siteState(pool, identity)).resolves.toEqual({
      activeReleaseId: published.releaseId,
      draftVersion: 3,
      releases: 1,
      revisions: 3,
    });
    const audit = await pool.query(
      `SELECT 1 FROM "AuditEvent"
        WHERE "resourceId" = $1 AND "action" = 'PROJECT_PUBLISHED'`,
      [published.releaseId],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('rejects a publish key reused with changed semantic payload', async () => {
    const operationId = uuid(0x510031);
    const baseInput = {
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      userId: identity.userId,
      operationId,
      requestId: uuid(0x510032),
      expectedDraftVersion: 1,
      siteConfig: fixture('v4-minimal-valid.json'),
    } as const;
    const published = await publishProject.execute(baseInput);

    await expect(
      publishProject.execute({
        ...baseInput,
        siteConfig: fixture('v4-full-valid.json'),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(siteState(pool, identity)).resolves.toEqual({
      activeReleaseId: published.releaseId,
      draftVersion: 2,
      releases: 1,
      revisions: 2,
    });
  });

  it('rejects malformed publish success replay tuples', async () => {
    const operationId = uuid(0x510035);
    const input = {
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      userId: identity.userId,
      operationId,
      requestId: uuid(0x510036),
      expectedDraftVersion: 1,
      siteConfig: fixture('v4-full-valid.json'),
    } as const;
    const published = await publishProject.execute(input);
    const stored = await storedIdempotency(
      pool,
      identity,
      'PUBLISH_PROJECT',
      operationId,
    );
    if (stored === undefined) throw new Error('Expected publish replay record');
    const corruptions = [
      { ...stored, httpStatus: 201 },
      { ...stored, resourceId: identity.projectId },
      {
        ...stored,
        responseBody: {
          ...stored.responseBody,
          workspaceId: identity.workspaceId,
        },
      },
    ];

    for (const corrupted of corruptions) {
      await replaceStoredIdempotencyTuple(
        pool,
        identity,
        'PUBLISH_PROJECT',
        operationId,
        corrupted,
      );
      await expect(publishProject.execute(input)).rejects.toThrow(
        'Stored idempotency release result is invalid',
      );
      await replaceStoredIdempotencyTuple(
        pool,
        identity,
        'PUBLISH_PROJECT',
        operationId,
        stored,
      );
    }
    await expect(siteState(pool, identity)).resolves.toMatchObject({
      activeReleaseId: published.releaseId,
      draftVersion: 2,
      releases: 1,
      revisions: 2,
    });
  });

  it('rejects a publish replay tuple pointing at a foreign release snapshot', async () => {
    const operationId = uuid(0x510037);
    const input = {
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      userId: identity.userId,
      operationId,
      requestId: uuid(0x510038),
      expectedDraftVersion: 1,
      siteConfig: fixture('v4-full-valid.json'),
    } as const;
    await publishProject.execute(input);
    const foreignBase = 0x6f0000 + fixtureOrdinal * 0x100;
    const foreign = fixtureIdentity(foreignBase);
    try {
      await seedIdentity(pool, foreignBase, foreign);
      const foreignRelease = await seedRelease(
        pool,
        foreign,
        uuid(0x510039),
        1,
      );
      await replaceStoredIdempotencyTuple(
        pool,
        identity,
        'PUBLISH_PROJECT',
        operationId,
        {
          httpStatus: 200,
          resourceId: foreignRelease.releaseId,
          responseBody: {
            releaseId: foreignRelease.releaseId,
            projectId: identity.projectId,
            version: foreignRelease.version,
            schemaVersion: 4,
          },
        },
      );
      await expect(publishProject.execute(input)).rejects.toThrow(
        'Stored idempotency release snapshot is unavailable',
      );
    } finally {
      await removeIdentity(pool, foreign);
    }
  });

  it('allows one of two different-key publish OCC racers and stores the stale conflict', async () => {
    const firstOperationId = uuid(0x510041);
    const secondOperationId = uuid(0x510042);
    const publish = (operationId: string, requestId: string) =>
      publishProject.execute({
        workspaceId: identity.workspaceId,
        projectId: identity.projectId,
        userId: identity.userId,
        operationId,
        requestId,
        expectedDraftVersion: 1,
        siteConfig: fixture('v4-full-valid.json'),
      });

    const settled = await Promise.allSettled([
      publish(firstOperationId, uuid(0x510043)),
      publish(secondOperationId, uuid(0x510044)),
    ]);

    expect(
      settled.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = settled.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: { code: 'PROJECT_VERSION_CONFLICT', currentDraftVersion: 2 },
    });
    await expect(siteState(pool, identity)).resolves.toMatchObject({
      draftVersion: 2,
      releases: 1,
      revisions: 2,
    });
    const records = await pool.query<{ httpStatus: number }>(
      `SELECT "httpStatus" FROM "IdempotencyRecord"
        WHERE "scope" = $1 AND "operation" = 'PUBLISH_PROJECT'
        ORDER BY "httpStatus"`,
      [projectScope(identity)],
    );
    expect(records.rows.map((row) => row.httpStatus)).toEqual([200, 409]);
  });

  it('rolls back publish rows, audit allocation, and replay state when audit throws', async () => {
    const sequenceBefore = await auditSequence(pool);
    const originalAppend = auditWriter.append.bind(auditWriter);
    jest
      .spyOn(auditWriter, 'append')
      .mockImplementationOnce(async (context, event) => {
        await originalAppend(context, event);
        throw new Error('forced publish audit failure');
      });

    await expect(
      publishProject.execute({
        workspaceId: identity.workspaceId,
        projectId: identity.projectId,
        userId: identity.userId,
        operationId: uuid(0x510051),
        requestId: uuid(0x510052),
        expectedDraftVersion: 1,
        siteConfig: fixture('v4-full-valid.json'),
      }),
    ).rejects.toThrow('forced publish audit failure');

    await expect(siteState(pool, identity)).resolves.toEqual({
      activeReleaseId: null,
      draftVersion: 1,
      releases: 0,
      revisions: 1,
    });
    await expect(auditSequence(pool)).resolves.toBe(sequenceBefore);
    await expect(
      storedIdempotency(pool, identity, 'PUBLISH_PROJECT', uuid(0x510051)),
    ).resolves.toBeUndefined();
  });

  it('does not duplicate a publish operation whose replay record is missing', async () => {
    const operationId = uuid(0x510061);
    const input = {
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      userId: identity.userId,
      operationId,
      requestId: uuid(0x510062),
      expectedDraftVersion: 1,
      siteConfig: fixture('v4-full-valid.json'),
    } as const;
    const published = await publishProject.execute(input);
    await pool.query(
      `DELETE FROM "IdempotencyRecord"
        WHERE "scope" = $1 AND "operation" = 'PUBLISH_PROJECT' AND "key" = $2`,
      [projectScope(identity), operationId],
    );

    await expect(publishProject.execute(input)).rejects.toThrow(
      'Publish operation exists without idempotency state',
    );
    await expect(siteState(pool, identity)).resolves.toEqual({
      activeReleaseId: published.releaseId,
      draftVersion: 2,
      releases: 1,
      revisions: 2,
    });
  });

  it('stores a uniform publish not-found outcome without business writes', async () => {
    const missingProject = { ...identity, projectId: uuid(0x510071) };
    const operationId = uuid(0x510072);
    await pool.query(`DELETE FROM "IdempotencyRecord" WHERE "scope" = $1`, [
      projectScope(missingProject),
    ]);
    try {
      await expect(
        publishProject.execute({
          workspaceId: identity.workspaceId,
          projectId: missingProject.projectId,
          userId: identity.userId,
          operationId,
          requestId: uuid(0x510073),
          expectedDraftVersion: 1,
          siteConfig: fixture('v4-full-valid.json'),
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await expect(
        storedIdempotency(pool, missingProject, 'PUBLISH_PROJECT', operationId),
      ).resolves.toMatchObject({
        httpStatus: 404,
        resourceId: null,
        responseBody: {
          code: 'NOT_FOUND',
          projectId: missingProject.projectId,
          workspaceId: identity.workspaceId,
        },
      });
      await expect(siteState(pool, identity)).resolves.toEqual({
        activeReleaseId: null,
        draftVersion: 1,
        releases: 0,
        revisions: 1,
      });
      const stored = await storedIdempotency(
        pool,
        missingProject,
        'PUBLISH_PROJECT',
        operationId,
      );
      if (stored === undefined) throw new Error('Expected publish 404 record');
      await replaceStoredIdempotencyTuple(
        pool,
        missingProject,
        'PUBLISH_PROJECT',
        operationId,
        { ...stored, httpStatus: 200 },
      );
      await expect(
        publishProject.execute({
          workspaceId: identity.workspaceId,
          projectId: missingProject.projectId,
          userId: identity.userId,
          operationId,
          requestId: uuid(0x510073),
          expectedDraftVersion: 1,
          siteConfig: fixture('v4-full-valid.json'),
        }),
      ).rejects.toThrow('Stored idempotency publish result is invalid');
    } finally {
      await pool.query(`DELETE FROM "IdempotencyRecord" WHERE "scope" = $1`, [
        projectScope(missingProject),
      ]);
    }
  });

  it('validates publish config before membership and idempotency work', async () => {
    const outsiderId = uuid(0x510081);
    await expect(
      publishProject.execute({
        workspaceId: identity.workspaceId,
        projectId: identity.projectId,
        userId: outsiderId,
        operationId: uuid(0x510082),
        requestId: uuid(0x510083),
        expectedDraftVersion: 1,
        siteConfig: { schemaVersion: 3 },
      }),
    ).rejects.toEqual(new SitesApplicationError('VALIDATION_ERROR'));
    const records = await pool.query(
      `SELECT 1 FROM "IdempotencyRecord"
        WHERE "scope" = $1 AND "operation" = 'PUBLISH_PROJECT'`,
      [projectScope(identity)],
    );
    expect(records.rows).toHaveLength(0);
  });

  it('activates an owned release by changing only the pointer and appending audit/replay rows', async () => {
    const first = await seedRelease(pool, identity, uuid(0x520001), 1, true);
    const second = await seedRelease(pool, identity, uuid(0x520002), 2);
    const operationId = uuid(0x520003);
    const requestId = uuid(0x520004);
    const releasesBefore = await pool.query(
      `SELECT "id", "operationId", "version", "siteConfig", "schemaVersion", "publishedAt"
         FROM "Release" WHERE "projectId" = $1 ORDER BY "id"`,
      [identity.projectId],
    );
    const projectBefore = await pool.query(
      `SELECT "id", "workspaceId", "createOperationId", "name", "publicSlug",
              "draft", "draftSchemaVersion", "draftVersion", "createdAt", "updatedAt"
         FROM "Project"
        WHERE "id" = $1 AND "workspaceId" = $2`,
      [identity.projectId, identity.workspaceId],
    );
    const revisionsBefore = await pool.query(
      `SELECT "id", "projectId", "operationId", "version", "siteConfig",
              "schemaVersion", "createdAt"
         FROM "ProjectRevision"
        WHERE "projectId" = $1
        ORDER BY "version", "id"`,
      [identity.projectId],
    );

    const result = await activateRelease.execute({
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      releaseId: second.releaseId,
      userId: identity.userId,
      operationId,
      requestId,
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(result).toEqual({
      releaseId: second.releaseId,
      projectId: identity.projectId,
      version: second.version,
      schemaVersion: 4,
    });
    await expect(siteState(pool, identity)).resolves.toEqual({
      activeReleaseId: second.releaseId,
      draftVersion: 1,
      releases: 2,
      revisions: 1,
    });
    const releasesAfter = await pool.query(
      `SELECT "id", "operationId", "version", "siteConfig", "schemaVersion", "publishedAt"
         FROM "Release" WHERE "projectId" = $1 ORDER BY "id"`,
      [identity.projectId],
    );
    const projectAfter = await pool.query(
      `SELECT "id", "workspaceId", "createOperationId", "name", "publicSlug",
              "draft", "draftSchemaVersion", "draftVersion", "createdAt", "updatedAt"
         FROM "Project"
        WHERE "id" = $1 AND "workspaceId" = $2`,
      [identity.projectId, identity.workspaceId],
    );
    const revisionsAfter = await pool.query(
      `SELECT "id", "projectId", "operationId", "version", "siteConfig",
              "schemaVersion", "createdAt"
         FROM "ProjectRevision"
        WHERE "projectId" = $1
        ORDER BY "version", "id"`,
      [identity.projectId],
    );
    expect(projectAfter.rows).toEqual(projectBefore.rows);
    expect(revisionsAfter.rows).toEqual(revisionsBefore.rows);
    expect(releasesAfter.rows).toEqual(releasesBefore.rows);
    expect(first.releaseId).not.toBe(second.releaseId);
    const audit = await pool.query<{
      action: string;
      actorUserId: string;
      metadata: unknown;
      requestId: string;
      resourceId: string;
      resourceType: string;
      workspaceId: string;
    }>(
      `SELECT "workspaceId", "actorUserId", "action", "resourceType",
              "resourceId", "metadata", "requestId"
         FROM "AuditEvent"
        WHERE "resourceId" = $1 AND "action" = 'RELEASE_ACTIVATED'
          AND "sequence" >= $2::bigint`,
      [second.releaseId, testAuditSequence.toString()],
    );
    expect(audit.rows).toEqual([
      {
        workspaceId: identity.workspaceId,
        actorUserId: identity.userId,
        action: 'RELEASE_ACTIVATED',
        resourceType: 'Release',
        resourceId: second.releaseId,
        metadata: { projectId: identity.projectId, version: 2 },
        requestId,
      },
    ]);
    await expect(
      storedIdempotency(pool, identity, 'ACTIVATE_RELEASE', operationId),
    ).resolves.toMatchObject({
      httpStatus: 200,
      responseBody: result,
      resourceId: second.releaseId,
    });
  });

  it('replays activation without restoring the original pointer or appending audit', async () => {
    const first = await seedRelease(pool, identity, uuid(0x520011), 1, true);
    const second = await seedRelease(pool, identity, uuid(0x520012), 2);
    const input = {
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      releaseId: second.releaseId,
      userId: identity.userId,
      operationId: uuid(0x520013),
      requestId: uuid(0x520014),
    } as const;
    const activated = await activateRelease.execute(input);
    await pool.query(
      `UPDATE "ActiveRelease" SET "releaseId" = $2 WHERE "projectId" = $1`,
      [identity.projectId, first.releaseId],
    );

    const replayed = await activateRelease.execute(input);

    expect(replayed).toEqual(activated);
    await expect(siteState(pool, identity)).resolves.toMatchObject({
      activeReleaseId: first.releaseId,
    });
    const audits = await pool.query(
      `SELECT 1 FROM "AuditEvent"
        WHERE "resourceId" = $1 AND "action" = 'RELEASE_ACTIVATED'
          AND "sequence" >= $2::bigint`,
      [second.releaseId, testAuditSequence.toString()],
    );
    expect(audits.rows).toHaveLength(1);
  });

  it('rejects an activation key reused for a different release', async () => {
    const first = await seedRelease(pool, identity, uuid(0x520021), 1, true);
    const second = await seedRelease(pool, identity, uuid(0x520022), 2);
    const operationId = uuid(0x520023);
    const base = {
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      userId: identity.userId,
      operationId,
      requestId: uuid(0x520024),
    } as const;
    await activateRelease.execute({ ...base, releaseId: second.releaseId });

    await expect(
      activateRelease.execute({ ...base, releaseId: first.releaseId }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(siteState(pool, identity)).resolves.toMatchObject({
      activeReleaseId: second.releaseId,
    });
  });

  it('stores 404 for a foreign release composite without changing either pointer', async () => {
    const ownRelease = await seedRelease(
      pool,
      identity,
      uuid(0x520031),
      1,
      true,
    );
    const foreignBase = 0x5f0000 + fixtureOrdinal * 0x100;
    const foreign = fixtureIdentity(foreignBase);
    const operationId = uuid(0x520033);
    try {
      await seedIdentity(pool, foreignBase, foreign);
      const foreignRelease = await seedRelease(
        pool,
        foreign,
        uuid(0x520032),
        1,
        true,
      );
      await expect(
        activateRelease.execute({
          workspaceId: identity.workspaceId,
          projectId: identity.projectId,
          releaseId: foreignRelease.releaseId,
          userId: identity.userId,
          operationId,
          requestId: uuid(0x520034),
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        storedIdempotency(pool, identity, 'ACTIVATE_RELEASE', operationId),
      ).resolves.toMatchObject({
        httpStatus: 404,
        responseBody: {
          code: 'NOT_FOUND',
          workspaceId: identity.workspaceId,
          projectId: identity.projectId,
          releaseId: foreignRelease.releaseId,
        },
        resourceId: null,
      });
      await expect(siteState(pool, identity)).resolves.toMatchObject({
        activeReleaseId: ownRelease.releaseId,
      });
      await expect(siteState(pool, foreign)).resolves.toMatchObject({
        activeReleaseId: foreignRelease.releaseId,
      });
    } finally {
      await removeIdentity(pool, foreign);
    }
  });

  it('rejects a malformed activation not-found replay tuple', async () => {
    const existing = await seedRelease(pool, identity, uuid(0x520035), 1, true);
    const missingReleaseId = uuid(0x520036);
    const operationId = uuid(0x520037);
    const input = {
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      releaseId: missingReleaseId,
      userId: identity.userId,
      operationId,
      requestId: uuid(0x520038),
    } as const;
    await expect(activateRelease.execute(input)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const stored = await storedIdempotency(
      pool,
      identity,
      'ACTIVATE_RELEASE',
      operationId,
    );
    if (stored === undefined) throw new Error('Expected activation 404 record');
    await replaceStoredIdempotencyTuple(
      pool,
      identity,
      'ACTIVATE_RELEASE',
      operationId,
      {
        ...stored,
        responseBody: {
          ...stored.responseBody,
          releaseId: existing.releaseId,
        },
      },
    );

    await expect(activateRelease.execute(input)).rejects.toThrow(
      'Stored idempotency activation result is invalid',
    );
    await expect(siteState(pool, identity)).resolves.toMatchObject({
      activeReleaseId: existing.releaseId,
      releases: 1,
      revisions: 1,
    });
  });

  it('rejects unknown runtime audit actions without allocating a sequence', async () => {
    const sequenceBefore = await auditSequence(pool);
    const eventId = uuid(0x520039);
    const forgedEvent = {
      eventId,
      workspaceId: identity.workspaceId,
      actorUserId: identity.userId,
      action: 'RELEASE_RELABELED',
      resourceType: 'Release',
      resourceId: uuid(0x52003a),
      metadata: { projectId: identity.projectId, version: 1 },
      requestId: uuid(0x52003b),
    } as unknown as Parameters<AuditWriter['append']>[1];

    await expect(
      transactions.run(async (context) => {
        await auditWriter.append(context, forgedEvent);
        throw new Error('Unsafe audit action was accepted');
      }),
    ).rejects.toThrow('Audit action is not allowlisted');
    await expect(auditSequence(pool)).resolves.toBe(sequenceBefore);
    const events = await pool.query(
      `SELECT 1 FROM "AuditEvent" WHERE "eventId" = $1`,
      [eventId],
    );
    expect(events.rows).toHaveLength(0);
  });

  it('rolls back activation pointer, audit allocation, and replay state when audit throws', async () => {
    const first = await seedRelease(pool, identity, uuid(0x520041), 1, true);
    const second = await seedRelease(pool, identity, uuid(0x520042), 2);
    const sequenceBefore = await auditSequence(pool);
    const originalAppend = auditWriter.append.bind(auditWriter);
    jest
      .spyOn(auditWriter, 'append')
      .mockImplementationOnce(async (context, event) => {
        await originalAppend(context, event);
        throw new Error('forced activation audit failure');
      });

    await expect(
      activateRelease.execute({
        workspaceId: identity.workspaceId,
        projectId: identity.projectId,
        releaseId: second.releaseId,
        userId: identity.userId,
        operationId: uuid(0x520043),
        requestId: uuid(0x520044),
      }),
    ).rejects.toThrow('forced activation audit failure');

    await expect(siteState(pool, identity)).resolves.toMatchObject({
      activeReleaseId: first.releaseId,
      draftVersion: 1,
      releases: 2,
      revisions: 1,
    });
    await expect(auditSequence(pool)).resolves.toBe(sequenceBefore);
    await expect(
      storedIdempotency(pool, identity, 'ACTIVATE_RELEASE', uuid(0x520043)),
    ).resolves.toBeUndefined();
  });
});
