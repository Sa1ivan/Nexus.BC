import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import {
  APP_CONFIG,
  type AppConfig,
} from '../../src/shared/config/app-config.schema';
import {
  AUDIT_WRITER,
  type AuditWriter,
} from '../../src/shared/audit/audit-writer';
import {
  PrismaTransactionClientService,
  TransactionRunner,
} from '../../src/shared/database/transaction-runner';
import { idempotencyAdvisoryLockId } from '../../src/shared/idempotency/idempotency-lock';

const allowedOrigin = 'http://localhost:4200';
const accessTokenSecret = 'test-access-token-secret-32-bytes';

interface TestIdentity {
  readonly accessToken: string;
  readonly email: string;
  readonly userId: string;
  readonly workspaceId: string;
}

interface SeededRelease {
  readonly id: string;
  readonly operationId: string;
  readonly siteConfig: Readonly<Record<string, unknown>>;
  readonly version: number;
}

interface SeededProject {
  readonly id: string;
  readonly publicSlug: string;
  readonly releases: readonly SeededRelease[];
}

interface ArtifactCounts {
  readonly activeReleases: number;
  readonly releases: number;
  readonly revisions: number;
}

interface ActiveReleaseRow {
  readonly activatedAt: Date;
  readonly releaseId: string;
}

interface AuditRow {
  readonly action: string;
  readonly actorUserId: string | null;
  readonly metadata: unknown;
  readonly requestId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly workspaceId: string | null;
}

interface IdempotencyRow {
  readonly httpStatus: number;
  readonly key: string;
  readonly operation: string;
  readonly resourceId: string | null;
  readonly responseBody: unknown;
  readonly scope: string;
}

interface ApplicationOptions {
  readonly auditFactory?: (transactions: TransactionRunner) => AuditWriter;
}

interface PointerWriteProbe {
  read(): Promise<number>;
  dispose(): Promise<void>;
}

interface DatabaseRaceGate {
  release(): Promise<void>;
  dispose(): Promise<void>;
  waitUntilBlocked(): Promise<void>;
}

interface TransactionProbeClient {
  $executeRawUnsafe(
    statement: string,
    ...values: readonly unknown[]
  ): Promise<number>;
  $queryRawUnsafe<T>(
    statement: string,
    ...values: readonly unknown[]
  ): Promise<T>;
}

interface RollbackAuditProbe {
  auditAttempted: boolean;
  auditWriteObserved: boolean;
  businessWritesObserved: boolean;
}

const suiteFixtures = {
  idempotencyKeys: new Set<string>(),
  projectIds: new Set<string>(),
  userIds: new Set<string>(),
  workspaceIds: new Set<string>(),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseBody(response: request.Response): Record<string, unknown> {
  const body: unknown = response.body;
  if (!isRecord(body)) throw new Error('Expected an object response body');
  return body;
}

function fixture(name: string): Record<string, unknown> {
  const path = resolve('contracts/site-config/fixtures', name);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`Fixture ${name} is not an object`);
  return parsed;
}

function reorderJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reorderJson(item)]),
  );
}

function namedSiteConfig(
  siteConfig: Readonly<Record<string, unknown>>,
  name: string,
): Readonly<Record<string, unknown>> {
  return { ...siteConfig, name };
}

function uniqueKey128(label: string): string {
  const unique = `${label}-${randomUUID().replaceAll('-', '')}`;
  if (unique.length > 128) throw new Error('Idempotency key label is too long');
  return unique.padEnd(128, 'x');
}

function errorCode(response: request.Response): unknown {
  const error = responseBody(response)['error'];
  return isRecord(error) ? error['code'] : undefined;
}

function responseRequestId(response: request.Response): string {
  const value: unknown = response.headers['x-request-id'];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Expected x-request-id response header');
  }
  return value;
}

function responseEtag(response: request.Response): string {
  const value: unknown = response.headers['etag'];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Expected ETag response header');
  }
  return value;
}

function releaseIdFromResponse(response: request.Response): string {
  const body = responseBody(response);
  const value = body['releaseId'] ?? body['id'];
  if (typeof value !== 'string') throw new Error('Expected release id');
  return value;
}

function signAccessToken(userId: string, email: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    'utf8',
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: userId,
      email,
      iat: issuedAt,
      exp: issuedAt + 600,
    }),
    'utf8',
  ).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signature = createHmac('sha256', accessTokenSecret)
    .update(unsigned, 'utf8')
    .digest('base64url');
  return `${unsigned}.${signature}`;
}

function authorize(identity: TestIdentity): {
  readonly Authorization: string;
} {
  return { Authorization: `Bearer ${identity.accessToken}` };
}

async function createApplication(
  options: ApplicationOptions = {},
): Promise<INestApplication<App>> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.auditFactory !== undefined) {
    builder.overrideProvider(AUDIT_WRITER).useFactory({
      factory: options.auditFactory,
      inject: [TransactionRunner],
    });
  }
  const moduleFixture = await builder.compile();
  const app = moduleFixture.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  app.useLogger(false);
  await app.init();
  return app;
}

async function seedIdentity(pool: Pool, label: string): Promise<TestIdentity> {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const email = `${label}-${userId}@example.test`;
  await pool.query(
    `INSERT INTO "User"
       ("id", "email", "passwordHash", "emailVerifiedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, 'not-used-by-public-release-contract', now(), now(), now())`,
    [userId, email],
  );
  suiteFixtures.userIds.add(userId);
  await pool.query(
    `INSERT INTO "Workspace" ("id", "name", "createdAt", "updatedAt")
     VALUES ($1, $2, now(), now())`,
    [workspaceId, `${label} workspace`],
  );
  suiteFixtures.workspaceIds.add(workspaceId);
  await pool.query(
    `INSERT INTO "Membership"
       ("workspaceId", "userId", "role", "createdAt", "updatedAt")
     VALUES ($1, $2, 'OWNER', now(), now())`,
    [workspaceId, userId],
  );
  return {
    userId,
    workspaceId,
    email,
    accessToken: signAccessToken(userId, email),
  };
}

async function seedReleasedProject(
  pool: Pool,
  identity: TestIdentity,
  siteConfigs: readonly Readonly<Record<string, unknown>>[],
  activeIndex: number | null = siteConfigs.length - 1,
): Promise<SeededProject> {
  const draft = siteConfigs.at(-1);
  if (draft === undefined || siteConfigs.length === 0) {
    throw new Error('Expected at least one site config');
  }
  if (
    activeIndex !== null &&
    (activeIndex < 0 || activeIndex >= siteConfigs.length)
  ) {
    throw new Error('Active release index is outside the fixture');
  }

  const projectId = randomUUID();
  const publicSlug = `public-${randomUUID()}`;
  await pool.query(
    `INSERT INTO "Project"
       ("id", "workspaceId", "createOperationId", "name", "publicSlug",
        "draft", "draftSchemaVersion", "draftVersion", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'Seeded release project', $4, $5::jsonb, 4, $6,
             now(), now())`,
    [
      projectId,
      identity.workspaceId,
      randomUUID(),
      publicSlug,
      JSON.stringify(draft),
      siteConfigs.length,
    ],
  );
  suiteFixtures.projectIds.add(projectId);

  const releases: SeededRelease[] = [];
  for (const [index, siteConfig] of siteConfigs.entries()) {
    const version = index + 1;
    await pool.query(
      `INSERT INTO "ProjectRevision"
         ("id", "projectId", "operationId", "version", "siteConfig",
          "schemaVersion", "createdAt")
       VALUES ($1, $2, $3, $4, $5::jsonb, 4, now())`,
      [
        randomUUID(),
        projectId,
        randomUUID(),
        version,
        JSON.stringify(siteConfig),
      ],
    );
    const release: SeededRelease = {
      id: randomUUID(),
      operationId: randomUUID(),
      siteConfig,
      version,
    };
    await pool.query(
      `INSERT INTO "Release"
         ("id", "projectId", "operationId", "version", "siteConfig",
          "schemaVersion", "publishedAt")
       VALUES ($1, $2, $3, $4, $5::jsonb, 4, now())`,
      [
        release.id,
        projectId,
        release.operationId,
        release.version,
        JSON.stringify(release.siteConfig),
      ],
    );
    releases.push(release);
  }

  if (activeIndex !== null) {
    const activeRelease = releases[activeIndex];
    if (activeRelease === undefined) {
      throw new Error('Expected active release fixture');
    }
    await pool.query(
      `INSERT INTO "ActiveRelease" ("projectId", "releaseId", "activatedAt")
       VALUES ($1, $2, '2020-01-01T00:00:00.000Z')`,
      [projectId, activeRelease.id],
    );
  }

  return { id: projectId, publicSlug, releases };
}

async function cleanupSuiteFixtures(pool: Pool): Promise<void> {
  const workspaceIds = [...suiteFixtures.workspaceIds];
  const userIds = [...suiteFixtures.userIds];
  const idempotencyKeys = [...suiteFixtures.idempotencyKeys];
  const shortIdempotencyKeys = idempotencyKeys.filter(
    (key) => key.length === 1,
  );
  const uniqueIdempotencyKeys = idempotencyKeys.filter(
    (key) => key.length !== 1,
  );

  if (workspaceIds.length > 0) {
    const ownedProjects = await pool.query<{ id: string }>(
      `SELECT "id" FROM "Project" WHERE "workspaceId" = ANY($1::uuid[])`,
      [workspaceIds],
    );
    for (const { id } of ownedProjects.rows) suiteFixtures.projectIds.add(id);
  }
  const projectIds = [...suiteFixtures.projectIds];
  const ownedReleases =
    projectIds.length === 0
      ? []
      : (
          await pool.query<{ id: string }>(
            `SELECT "id" FROM "Release" WHERE "projectId" = ANY($1::uuid[])`,
            [projectIds],
          )
        ).rows.map(({ id }) => id);
  const ownedResourceIds = [...projectIds, ...ownedReleases];

  if (uniqueIdempotencyKeys.length > 0) {
    await pool.query(
      `DELETE FROM "IdempotencyRecord" WHERE "key" = ANY($1::text[])`,
      [uniqueIdempotencyKeys],
    );
  }
  if (shortIdempotencyKeys.length > 0 && ownedResourceIds.length > 0) {
    await pool.query(
      `DELETE FROM "IdempotencyRecord"
        WHERE "key" = ANY($1::text[])
          AND "resourceId" = ANY($2::text[])`,
      [shortIdempotencyKeys, ownedResourceIds],
    );
  }
  if (projectIds.length > 0) {
    await pool.query(
      `DELETE FROM "ActiveRelease" WHERE "projectId" = ANY($1::uuid[])`,
      [projectIds],
    );
    await pool.query(
      `DELETE FROM "Release" WHERE "projectId" = ANY($1::uuid[])`,
      [projectIds],
    );
    await pool.query(
      `DELETE FROM "ProjectRevision" WHERE "projectId" = ANY($1::uuid[])`,
      [projectIds],
    );
    await pool.query(`DELETE FROM "Project" WHERE "id" = ANY($1::uuid[])`, [
      projectIds,
    ]);
  }
  if (workspaceIds.length > 0 || userIds.length > 0) {
    await pool.query(
      `DELETE FROM "Membership"
        WHERE "workspaceId" = ANY($1::uuid[]) OR "userId" = ANY($2::uuid[])`,
      [workspaceIds, userIds],
    );
  }
  if (workspaceIds.length > 0) {
    await pool.query(`DELETE FROM "Workspace" WHERE "id" = ANY($1::uuid[])`, [
      workspaceIds,
    ]);
  }
  if (userIds.length > 0) {
    await pool.query(`DELETE FROM "User" WHERE "id" = ANY($1::uuid[])`, [
      userIds,
    ]);
  }

  const remaining = await pool.query<{
    activeReleases: string;
    idempotencyRecords: string;
    memberships: string;
    projects: string;
    releases: string;
    revisions: string;
    users: string;
    workspaces: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM "ActiveRelease"
         WHERE "projectId" = ANY($1::uuid[]))::bigint AS "activeReleases",
       (SELECT COUNT(*) FROM "Release"
         WHERE "projectId" = ANY($1::uuid[]))::bigint AS "releases",
       (SELECT COUNT(*) FROM "ProjectRevision"
         WHERE "projectId" = ANY($1::uuid[]))::bigint AS "revisions",
       (SELECT COUNT(*) FROM "Project"
         WHERE "id" = ANY($1::uuid[]))::bigint AS "projects",
       (SELECT COUNT(*) FROM "IdempotencyRecord"
         WHERE "key" = ANY($2::text[])
            OR ("key" = ANY($5::text[])
                AND "resourceId" = ANY($6::text[])))::bigint
         AS "idempotencyRecords",
       (SELECT COUNT(*) FROM "Membership"
         WHERE "workspaceId" = ANY($3::uuid[]) OR "userId" = ANY($4::uuid[]))::bigint
         AS "memberships",
       (SELECT COUNT(*) FROM "Workspace"
         WHERE "id" = ANY($3::uuid[]))::bigint AS "workspaces",
       (SELECT COUNT(*) FROM "User"
         WHERE "id" = ANY($4::uuid[]))::bigint AS "users"`,
    [
      projectIds,
      uniqueIdempotencyKeys,
      workspaceIds,
      userIds,
      shortIdempotencyKeys,
      ownedResourceIds,
    ],
  );
  const counts = remaining.rows[0];
  if (
    counts === undefined ||
    Object.values(counts).some((count) => Number(count) !== 0)
  ) {
    throw new Error('Suite-owned database fixtures were not fully cleaned up');
  }
}

function transactionalFailingAuditFactory(input: {
  readonly action: string;
  readonly actorUserId: string;
  readonly businessProbe: (
    transaction: TransactionProbeClient,
  ) => Promise<boolean>;
  readonly probe: RollbackAuditProbe;
  readonly resourceId: string;
  readonly workspaceId: string;
}): (transactions: TransactionRunner) => AuditWriter {
  const auditId = randomUUID();
  const eventId = randomUUID();
  const requestId = randomUUID();
  return (transactions) => ({
    append: (context) =>
      transactions[PrismaTransactionClientService](context, async (client) => {
        const transaction = client as TransactionProbeClient;
        input.probe.auditAttempted = true;
        input.probe.businessWritesObserved =
          await input.businessProbe(transaction);

        await transaction.$queryRawUnsafe<Array<{ setConfig: string }>>(
          `SELECT set_config('nexus.audit_writer', 'enabled', true)`,
        );
        const sequenceRows = await transaction.$queryRawUnsafe<
          Array<{ nextValue: bigint }>
        >(
          `SELECT "nextValue" FROM "AuditSequence"
              WHERE "id" = 1 FOR UPDATE`,
        );
        const sequence = sequenceRows[0]?.nextValue;
        if (sequence === undefined) {
          throw new Error('AuditSequence singleton is missing');
        }
        await transaction.$executeRawUnsafe(
          `UPDATE "AuditSequence" SET "nextValue" = $1 WHERE "id" = 1`,
          sequence + 1n,
        );
        await transaction.$executeRawUnsafe(
          `INSERT INTO "AuditEvent"
               ("id", "eventId", "sequence", "workspaceId", "actorUserId",
                "action", "resourceType", "resourceId", "metadata", "requestId")
             VALUES ($1, $2, $3, $4, $5, $6, 'Release', $7,
                     '{"testOnly":true}'::jsonb, $8)`,
          auditId,
          eventId,
          sequence,
          input.workspaceId,
          input.actorUserId,
          input.action,
          input.resourceId,
          requestId,
        );
        const written = await transaction.$queryRawUnsafe<
          Array<{ events: bigint; nextValue: bigint }>
        >(
          `SELECT
               (SELECT COUNT(*) FROM "AuditEvent" WHERE "eventId" = $1)::bigint
                 AS "events",
               (SELECT "nextValue" FROM "AuditSequence" WHERE "id" = 1)
                 AS "nextValue"`,
          eventId,
        );
        input.probe.auditWriteObserved =
          written[0]?.events === 1n && written[0]?.nextValue === sequence + 1n;
        throw new Error('forced transactional audit failure private marker');
      }),
  });
}

async function auditSequenceNextValue(pool: Pool): Promise<string> {
  const result = await pool.query<{ nextValue: string }>(
    `SELECT "nextValue" FROM "AuditSequence" WHERE "id" = 1`,
  );
  const nextValue = result.rows[0]?.nextValue;
  if (nextValue === undefined) throw new Error('AuditSequence is missing');
  return nextValue;
}

function createProjectRequest(
  app: INestApplication<App>,
  identity: TestIdentity,
  operationId: string,
  siteConfig: unknown,
): request.Test {
  suiteFixtures.idempotencyKeys.add(operationId);
  return request(app.getHttpServer())
    .post(`/v1/workspaces/${identity.workspaceId}/projects`)
    .set(authorize(identity))
    .set('Origin', allowedOrigin)
    .set('Idempotency-Key', operationId)
    .send({ name: 'Release contract project', siteConfig });
}

function publishRequest(
  app: INestApplication<App>,
  identity: TestIdentity,
  projectId: string,
  operationId: string,
  expectedDraftVersion: number,
  siteConfig: unknown,
): request.Test {
  suiteFixtures.idempotencyKeys.add(operationId);
  return request(app.getHttpServer())
    .post(
      `/v1/workspaces/${identity.workspaceId}/projects/${projectId}/publish`,
    )
    .set(authorize(identity))
    .set('Origin', allowedOrigin)
    .set('Idempotency-Key', operationId)
    .send({ expectedDraftVersion, siteConfig });
}

function publishForWorkspaceRequest(
  app: INestApplication<App>,
  identity: TestIdentity,
  workspaceId: string,
  projectId: string,
  operationId: string,
  expectedDraftVersion: number,
  siteConfig: unknown,
): request.Test {
  suiteFixtures.idempotencyKeys.add(operationId);
  return request(app.getHttpServer())
    .post(`/v1/workspaces/${workspaceId}/projects/${projectId}/publish`)
    .set(authorize(identity))
    .set('Origin', allowedOrigin)
    .set('Idempotency-Key', operationId)
    .send({ expectedDraftVersion, siteConfig });
}

function saveDraftRequest(
  app: INestApplication<App>,
  identity: TestIdentity,
  projectId: string,
  operationId: string,
  expectedDraftVersion: number,
  siteConfig: unknown,
): request.Test {
  suiteFixtures.idempotencyKeys.add(operationId);
  return request(app.getHttpServer())
    .put(`/v1/workspaces/${identity.workspaceId}/projects/${projectId}/draft`)
    .set(authorize(identity))
    .set('Origin', allowedOrigin)
    .set('Idempotency-Key', operationId)
    .send({ expectedDraftVersion, siteConfig });
}

function activateRequest(
  app: INestApplication<App>,
  identity: TestIdentity,
  projectId: string,
  releaseId: string,
  operationId: string,
  workspaceId = identity.workspaceId,
): request.Test {
  suiteFixtures.idempotencyKeys.add(operationId);
  return request(app.getHttpServer())
    .post(
      `/v1/workspaces/${workspaceId}/projects/${projectId}/releases/${releaseId}/activate`,
    )
    .set(authorize(identity))
    .set('Origin', allowedOrigin)
    .set('Idempotency-Key', operationId);
}

function publicSiteRequest(
  app: INestApplication<App>,
  publicSlug: string,
): request.Test {
  return request(app.getHttpServer()).get(
    `/v1/public/sites/${encodeURIComponent(publicSlug)}`,
  );
}

function publicPageRequest(
  app: INestApplication<App>,
  publicSlug: string,
  pageSlug: string,
): request.Test {
  return request(app.getHttpServer()).get(
    `/v1/public/sites/${encodeURIComponent(publicSlug)}/pages/${encodeURIComponent(pageSlug)}`,
  );
}

function projectId(response: request.Response): string {
  const value = responseBody(response)['id'];
  if (typeof value !== 'string') throw new Error('Expected project id');
  suiteFixtures.projectIds.add(value);
  return value;
}

async function artifactCounts(
  pool: Pool,
  projectId: string,
): Promise<ArtifactCounts> {
  const result = await pool.query<{
    activeReleases: string;
    releases: string;
    revisions: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM "ProjectRevision" WHERE "projectId" = $1)
         AS "revisions",
       (SELECT COUNT(*) FROM "Release" WHERE "projectId" = $1)
         AS "releases",
       (SELECT COUNT(*) FROM "ActiveRelease" WHERE "projectId" = $1)
         AS "activeReleases"`,
    [projectId],
  );
  const counts = result.rows[0];
  if (counts === undefined) throw new Error('Expected artifact counts');
  return {
    activeReleases: Number(counts.activeReleases),
    releases: Number(counts.releases),
    revisions: Number(counts.revisions),
  };
}

async function activeRelease(
  pool: Pool,
  projectId: string,
): Promise<ActiveReleaseRow | null> {
  const result = await pool.query<ActiveReleaseRow>(
    `SELECT "releaseId", "activatedAt"
       FROM "ActiveRelease"
      WHERE "projectId" = $1`,
    [projectId],
  );
  return result.rows[0] ?? null;
}

async function installPointerWriteProbe(
  pool: Pool,
  projectId: string,
): Promise<PointerWriteProbe> {
  const token = randomUUID().replaceAll('-', '');
  const tableName = `p105_pointer_counter_${token}`;
  const functionName = `p105_count_pointer_${token}`;
  const triggerName = `p105_watch_pointer_${token}`;
  let tableCreated = false;
  let functionCreated = false;
  let triggerCreated = false;

  const dispose = async (): Promise<void> => {
    try {
      if (triggerCreated) {
        await pool.query(
          `DROP TRIGGER IF EXISTS "${triggerName}" ON "ActiveRelease"`,
        );
      }
    } finally {
      try {
        if (functionCreated) {
          await pool.query(`DROP FUNCTION IF EXISTS "${functionName}"()`);
        }
      } finally {
        if (tableCreated) {
          await pool.query(`DROP TABLE IF EXISTS "${tableName}"`);
        }
      }
    }
  };

  try {
    await pool.query(
      `CREATE UNLOGGED TABLE "${tableName}" ("writes" integer NOT NULL)`,
    );
    tableCreated = true;
    await pool.query(`INSERT INTO "${tableName}" ("writes") VALUES (0)`);
    await pool.query(
      `CREATE FUNCTION "${functionName}"() RETURNS trigger
       LANGUAGE plpgsql AS $p105$
       BEGIN
         IF NEW."projectId"::text = TG_ARGV[0] THEN
           UPDATE "${tableName}" SET "writes" = "writes" + 1;
         END IF;
         RETURN NEW;
       END
       $p105$`,
    );
    functionCreated = true;
    await pool.query(
      `CREATE TRIGGER "${triggerName}"
       AFTER INSERT OR UPDATE ON "ActiveRelease"
       FOR EACH ROW EXECUTE FUNCTION "${functionName}"('${projectId}')`,
    );
    triggerCreated = true;
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    read: async () => {
      const result = await pool.query<{ writes: number }>(
        `SELECT "writes" FROM "${tableName}"`,
      );
      const writes = result.rows[0]?.writes;
      if (writes === undefined) throw new Error('Pointer counter is missing');
      return writes;
    },
    dispose,
  };
}

function advisoryLockParts(lockId: bigint): {
  readonly classId: string;
  readonly objectId: string;
} {
  const unsignedLockId = BigInt.asUintN(64, lockId);
  return {
    classId: (unsignedLockId >> 32n).toString(),
    objectId: (unsignedLockId & 0xffff_ffffn).toString(),
  };
}

async function waitForAdvisoryLock(
  pool: Pool,
  lockId: bigint,
  granted: boolean,
): Promise<void> {
  const parts = advisoryLockParts(lockId);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS "count"
         FROM pg_locks
        WHERE locktype = 'advisory'
          AND classid::bigint = $1::bigint
          AND objid::bigint = $2::bigint
          AND granted = $3`,
      [parts.classId, parts.objectId, granted],
    );
    if (Number(result.rows[0]?.count ?? 0) > 0) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(
    `Timed out waiting for advisory lock ${lockId.toString()} (granted=${String(granted)})`,
  );
}

async function installDatabaseRaceGate(
  pool: Pool,
  projectId: string,
  target: 'Project' | 'ActiveRelease',
): Promise<DatabaseRaceGate> {
  const token = randomUUID().replaceAll('-', '');
  const functionName = `p105_race_gate_${token}`;
  const triggerName = `p105_wait_race_${token}`;
  const lockId = BigInt(`0x${token.slice(0, 15)}`);
  const controller = await pool.connect();
  let functionCreated = false;
  let triggerCreated = false;
  let lockHeld = false;

  const release = async (): Promise<void> => {
    if (!lockHeld) return;
    await controller.query('SELECT pg_advisory_unlock($1::bigint)', [
      lockId.toString(),
    ]);
    lockHeld = false;
  };
  const dispose = async (): Promise<void> => {
    try {
      await release();
      if (triggerCreated) {
        await pool.query(
          `DROP TRIGGER IF EXISTS "${triggerName}" ON "${target}"`,
        );
      }
    } finally {
      try {
        if (functionCreated) {
          await pool.query(`DROP FUNCTION IF EXISTS "${functionName}"()`);
        }
      } finally {
        controller.release();
      }
    }
  };

  try {
    await controller.query('SELECT pg_advisory_lock($1::bigint)', [
      lockId.toString(),
    ]);
    lockHeld = true;
    const projectColumn = target === 'Project' ? 'id' : 'projectId';
    await pool.query(
      `CREATE FUNCTION "${functionName}"() RETURNS trigger
       LANGUAGE plpgsql AS $p105$
       BEGIN
         IF NEW."${projectColumn}"::text = TG_ARGV[0] THEN
           PERFORM pg_advisory_xact_lock(TG_ARGV[1]::bigint);
         END IF;
         RETURN NEW;
       END
       $p105$`,
    );
    functionCreated = true;
    const event = target === 'Project' ? 'UPDATE' : 'INSERT OR UPDATE';
    await pool.query(
      `CREATE TRIGGER "${triggerName}"
       BEFORE ${event} ON "${target}"
       FOR EACH ROW EXECUTE FUNCTION "${functionName}"('${projectId}', '${lockId.toString()}')`,
    );
    triggerCreated = true;
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    release,
    dispose,
    waitUntilBlocked: () => waitForAdvisoryLock(pool, lockId, false),
  };
}

async function idempotencyRows(
  pool: Pool,
  keys: readonly string[],
): Promise<IdempotencyRow[]> {
  const result = await pool.query<IdempotencyRow>(
    `SELECT "scope", "operation", "key", "httpStatus", "responseBody", "resourceId"
       FROM "IdempotencyRecord"
      WHERE "key" = ANY($1::text[])
      ORDER BY "scope", "operation", "key"`,
    [[...keys]],
  );
  return result.rows;
}

function idempotencyIdentity(row: IdempotencyRow): string {
  return JSON.stringify([row.scope, row.operation, row.key]);
}

async function idempotencyIdentityCount(
  pool: Pool,
  row: IdempotencyRow,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS "count"
       FROM "IdempotencyRecord"
      WHERE "scope" = $1 AND "operation" = $2 AND "key" = $3`,
    [row.scope, row.operation, row.key],
  );
  return Number(result.rows[0]?.count ?? -1);
}

async function expectOneStoredIdentity(
  pool: Pool,
  key: string,
): Promise<IdempotencyRow> {
  const rows = await idempotencyRows(pool, [key]);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) throw new Error('Expected idempotency identity');
  await expect(idempotencyIdentityCount(pool, row)).resolves.toBe(1);
  return row;
}

async function auditRows(pool: Pool, workspaceId: string): Promise<AuditRow[]> {
  const result = await pool.query<AuditRow>(
    `SELECT "workspaceId", "actorUserId", "action", "resourceType",
            "resourceId", "metadata", "requestId"
       FROM "AuditEvent"
      WHERE "workspaceId" = $1
      ORDER BY "sequence"`,
    [workspaceId],
  );
  return result.rows;
}

async function persistedProjectSnapshot(
  pool: Pool,
  projectId: string,
): Promise<Readonly<Record<string, unknown>>> {
  const project = await pool.query(
    `SELECT "id", "workspaceId", "createOperationId", "name", "publicSlug",
            "draft", "draftSchemaVersion", "draftVersion", "createdAt",
            "updatedAt"
       FROM "Project" WHERE "id" = $1`,
    [projectId],
  );
  const revisions = await pool.query(
    `SELECT "id", "projectId", "operationId", "version", "siteConfig",
            "schemaVersion", "createdAt"
       FROM "ProjectRevision"
      WHERE "projectId" = $1
      ORDER BY "version"`,
    [projectId],
  );
  const releases = await pool.query(
    `SELECT "id", "projectId", "operationId", "version", "siteConfig",
            "schemaVersion", "publishedAt"
       FROM "Release"
      WHERE "projectId" = $1
      ORDER BY "version"`,
    [projectId],
  );
  return {
    project: project.rows,
    revisions: revisions.rows,
    releases: releases.rows,
  };
}

function expectSafeAuditEvent(
  audit: AuditRow,
  identity: TestIdentity,
  resourceIds: readonly string[],
  requestIds: readonly string[],
): void {
  expect(audit).toMatchObject({
    workspaceId: identity.workspaceId,
    actorUserId: identity.userId,
  });
  expect(audit.action).toMatch(/^[A-Z][A-Z0-9_]{1,127}$/u);
  expect(audit.resourceType).toMatch(/^[A-Za-z][A-Za-z0-9]{0,63}$/u);
  expect(resourceIds).toContain(audit.resourceId);
  expect(requestIds).toContain(audit.requestId);
  expect(isRecord(audit.metadata)).toBe(true);

  const serialized = JSON.stringify(audit.metadata);
  expect(serialized).not.toContain(identity.email);
  expect(serialized).not.toContain('hello@nexus.app');
  expect(serialized).not.toContain('+7 999 000-00-00');
  expect(serialized).not.toContain('siteConfig');
  expect(serialized).not.toContain('requestFingerprint');
}

function expectedPage(
  siteConfig: Readonly<Record<string, unknown>>,
  pageSlug?: string,
): unknown {
  const pages = siteConfig['pages'];
  if (!Array.isArray(pages)) throw new Error('Expected fixture pages');
  const pageValues = pages as readonly unknown[];
  const page =
    pageSlug === undefined
      ? pageValues[0]
      : pageValues.find(
          (value) => isRecord(value) && value['slug'] === pageSlug,
        );
  if (page === undefined) throw new Error('Expected fixture page');
  return page;
}

function namedRepresentationValues(
  value: unknown,
  names: ReadonlySet<string>,
  matches: unknown[] = [],
): readonly unknown[] {
  if (Array.isArray(value)) {
    for (const item of value as readonly unknown[]) {
      namedRepresentationValues(item, names, matches);
    }
    return matches;
  }
  if (!isRecord(value)) return matches;
  for (const [key, item] of Object.entries(value)) {
    if (names.has(key)) matches.push(item);
    namedRepresentationValues(item, names, matches);
  }
  return matches;
}

function expectPublicRepresentation(
  response: request.Response,
  release: SeededRelease,
  configuration: AppConfig,
  pageSlug?: string,
): void {
  const body = responseBody(response);
  expect(body).toEqual({
    releaseId: release.id,
    releaseVersion: release.version,
    schemaVersion: 4,
    theme: release.siteConfig['theme'],
    business: release.siteConfig['business'],
    seo: release.siteConfig['seo'],
    chrome: release.siteConfig['chrome'],
    page: expectedPage(release.siteConfig, pageSlug),
    privacyNotice: {
      url: configuration.privacyNoticeUrl,
      version: configuration.privacyNoticeVersion,
    },
  });
}

function normalizedServerRequestIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).map(normalizedServerRequestIds);
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key !== 'requestId') {
        return [key, normalizedServerRequestIds(item)];
      }
      expect(item).toEqual(expect.any(String));
      return [key, '<server-request-id>'];
    }),
  );
}

function normalizedNotFound(response: request.Response): unknown {
  expect(response.status).toBe(404);
  const body = responseBody(response);
  const error = body['error'];
  if (!isRecord(error)) throw new Error('Expected error envelope');
  expect(Object.keys(body)).toEqual(['error']);
  expect(Object.keys(error).sort()).toEqual(['code', 'message', 'requestId']);
  expect(error['code']).toBe('NOT_FOUND');
  expect(namedRepresentationValues(body, new Set(['requestId']))).toHaveLength(
    1,
  );
  return normalizedServerRequestIds(body);
}

describe('immutable releases and anonymous public sites HTTP contract', () => {
  let app: INestApplication<App>;
  let configuration: AppConfig;
  let pool: Pool;
  let owner: TestIdentity;
  let otherOwner: TestIdentity;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
    app = await createApplication();
    configuration = app.get<AppConfig>(APP_CONFIG);
  });

  beforeEach(async () => {
    owner = await seedIdentity(pool, 'owner');
    otherOwner = await seedIdentity(pool, 'other-owner');
  });

  afterAll(async () => {
    try {
      await app.close();
    } finally {
      try {
        await cleanupSuiteFixtures(pool);
      } finally {
        await pool.end();
      }
    }
  });

  it('guards publish and activate with authentication, UUID, origin, capabilities, membership, and bounded keys before writes', async () => {
    const siteConfig = fixture('v4-minimal-valid.json');
    const project = await seedReleasedProject(pool, owner, [siteConfig]);
    const release = project.releases[0];
    if (release === undefined) throw new Error('Expected release fixture');
    const before = await persistedProjectSnapshot(pool, project.id);
    const beforeArtifacts = await artifactCounts(pool, project.id);
    const pointerBefore = await activeRelease(pool, project.id);
    const invalidKeys = {
      activateBadCapabilities: randomUUID(),
      activateBadProjectId: randomUUID(),
      activateBadReleaseId: randomUUID(),
      activateBadWorkspaceId: randomUUID(),
      activateMissingOrigin: randomUUID(),
      activateTooLong: 'a'.repeat(129),
      activateUnauthorized: randomUUID(),
      publishBadCapabilities: randomUUID(),
      publishBadProjectId: randomUUID(),
      publishBadWorkspaceId: randomUUID(),
      publishMissingOrigin: randomUUID(),
      publishTooLong: 'p'.repeat(129),
      publishUnauthorized: randomUUID(),
      publishVersionAtWriteOverflow: randomUUID(),
      publishVersionOutsideInt4: randomUUID(),
      publishWrongMember: randomUUID(),
    };
    for (const key of Object.values(invalidKeys)) {
      suiteFixtures.idempotencyKeys.add(key);
    }

    await request(app.getHttpServer())
      .post(
        `/v1/workspaces/${owner.workspaceId}/projects/${project.id}/publish`,
      )
      .set('Origin', allowedOrigin)
      .set('Idempotency-Key', invalidKeys.publishUnauthorized)
      .send({ expectedDraftVersion: 1, siteConfig })
      .expect(401);
    await publishRequest(app, owner, project.id, randomUUID(), 1, siteConfig)
      .unset('Idempotency-Key')
      .expect(400);
    await publishRequest(
      app,
      owner,
      project.id,
      invalidKeys.publishTooLong,
      1,
      siteConfig,
    ).expect(400);
    await publishRequest(
      app,
      owner,
      project.id,
      invalidKeys.publishMissingOrigin,
      1,
      siteConfig,
    )
      .unset('Origin')
      .expect(403);
    await publishRequest(
      app,
      owner,
      project.id,
      invalidKeys.publishBadCapabilities,
      1,
      siteConfig,
    )
      .set(
        'Nexus-Client-Capabilities',
        'site-config-read=4, 5;site-config-write=4,5',
      )
      .expect(400);
    await publishForWorkspaceRequest(
      app,
      otherOwner,
      owner.workspaceId,
      project.id,
      invalidKeys.publishWrongMember,
      1,
      siteConfig,
    ).expect(404);
    await publishRequest(
      app,
      owner,
      'not-a-uuid',
      invalidKeys.publishBadProjectId,
      1,
      siteConfig,
    ).expect(404);
    await publishForWorkspaceRequest(
      app,
      owner,
      'not-a-uuid',
      project.id,
      invalidKeys.publishBadWorkspaceId,
      1,
      siteConfig,
    ).expect(404);
    await publishRequest(
      app,
      owner,
      project.id,
      invalidKeys.publishVersionAtWriteOverflow,
      2_147_483_647,
      siteConfig,
    ).expect(400);
    await publishRequest(
      app,
      owner,
      project.id,
      invalidKeys.publishVersionOutsideInt4,
      2_147_483_648,
      siteConfig,
    ).expect(400);

    await request(app.getHttpServer())
      .post(
        `/v1/workspaces/${owner.workspaceId}/projects/${project.id}/releases/${release.id}/activate`,
      )
      .set('Origin', allowedOrigin)
      .set('Idempotency-Key', invalidKeys.activateUnauthorized)
      .expect(401);
    await activateRequest(app, owner, project.id, release.id, randomUUID())
      .unset('Idempotency-Key')
      .expect(400);
    await activateRequest(
      app,
      owner,
      project.id,
      release.id,
      invalidKeys.activateTooLong,
    ).expect(400);
    await activateRequest(
      app,
      owner,
      project.id,
      release.id,
      invalidKeys.activateMissingOrigin,
    )
      .unset('Origin')
      .expect(403);
    await activateRequest(
      app,
      owner,
      project.id,
      release.id,
      invalidKeys.activateBadCapabilities,
    )
      .set(
        'Nexus-Client-Capabilities',
        'site-config-read=4;site-config-write=4;extra=4',
      )
      .expect(400);
    await activateRequest(
      app,
      owner,
      project.id,
      'not-a-uuid',
      invalidKeys.activateBadReleaseId,
    ).expect(404);
    await activateRequest(
      app,
      owner,
      'not-a-uuid',
      release.id,
      invalidKeys.activateBadProjectId,
    ).expect(404);
    await activateRequest(
      app,
      owner,
      project.id,
      release.id,
      invalidKeys.activateBadWorkspaceId,
      'not-a-uuid',
    ).expect(404);

    await expect(persistedProjectSnapshot(pool, project.id)).resolves.toEqual(
      before,
    );
    await expect(artifactCounts(pool, project.id)).resolves.toEqual(
      beforeArtifacts,
    );
    await expect(activeRelease(pool, project.id)).resolves.toEqual(
      pointerBefore,
    );
    await expect(
      idempotencyRows(pool, Object.values(invalidKeys)),
    ).resolves.toEqual([]);
    await expect(auditRows(pool, owner.workspaceId)).resolves.toEqual([]);

    const oneCharacterPublishKey = 'p';
    const published = await publishRequest(
      app,
      owner,
      project.id,
      oneCharacterPublishKey,
      1,
      fixture('v4-bundled-images-valid.json'),
    ).expect(200);
    const publishedReleaseId = releaseIdFromResponse(published);
    const oneCharacterActivateKey = 'a';
    const activated = await activateRequest(
      app,
      owner,
      project.id,
      release.id,
      oneCharacterActivateKey,
    ).expect(200);
    expect(releaseIdFromResponse(activated)).toBe(release.id);

    const boundaryRows = (
      await idempotencyRows(pool, [
        oneCharacterPublishKey,
        oneCharacterActivateKey,
      ])
    ).filter(({ resourceId }) =>
      [publishedReleaseId, release.id].includes(resourceId ?? ''),
    );
    expect(boundaryRows).toHaveLength(2);
    expect(boundaryRows.map(({ key }) => key).sort()).toEqual(['a', 'p']);
    for (const row of boundaryRows) {
      await expect(idempotencyIdentityCount(pool, row)).resolves.toBe(1);
    }
    await expect(activeRelease(pool, project.id)).resolves.toMatchObject({
      releaseId: release.id,
    });
    await expect(artifactCounts(pool, project.id)).resolves.toEqual({
      revisions: 2,
      releases: 2,
      activeReleases: 1,
    });
    await expect(auditRows(pool, owner.workspaceId)).resolves.toHaveLength(2);
  });

  it('validates the exact v4 publish body before creating revision, release, activation, audit, or replay state', async () => {
    const created = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    ).expect(201);
    const id = projectId(created);
    const invalidKey = randomUUID();
    const extraFieldKey = randomUUID();

    const invalid = await publishRequest(
      app,
      owner,
      id,
      invalidKey,
      1,
      fixture('v4-data-url-rejected.json'),
    ).expect(400);
    expect(errorCode(invalid)).toBe('VALIDATION_ERROR');
    const extraField = await publishRequest(
      app,
      owner,
      id,
      extraFieldKey,
      1,
      fixture('v4-minimal-valid.json'),
    )
      .send({
        expectedDraftVersion: 1,
        siteConfig: fixture('v4-minimal-valid.json'),
        workspaceId: owner.workspaceId,
      })
      .expect(400);
    expect(errorCode(extraField)).toBe('VALIDATION_ERROR');
    await expect(artifactCounts(pool, id)).resolves.toEqual({
      revisions: 1,
      releases: 0,
      activeReleases: 0,
    });
    await expect(
      idempotencyRows(pool, [invalidKey, extraFieldKey]),
    ).resolves.toEqual([]);
    await expect(auditRows(pool, owner.workspaceId)).resolves.toEqual([]);
  });

  it('rolls back draft, revision, release, activation, replay, and audit when publish audit append fails after business writes begin', async () => {
    const created = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    ).expect(201);
    const id = projectId(created);
    const operationId = uniqueKey128('publish-audit-failure');
    const before = await persistedProjectSnapshot(pool, id);
    const auditBefore = await auditRows(pool, owner.workspaceId);
    const sequenceBefore = await auditSequenceNextValue(pool);
    const probe: RollbackAuditProbe = {
      auditAttempted: false,
      auditWriteObserved: false,
      businessWritesObserved: false,
    };
    const failingApp = await createApplication({
      auditFactory: transactionalFailingAuditFactory({
        action: 'TEST_PUBLISH_ROLLBACK',
        actorUserId: owner.userId,
        businessProbe: async (transaction) => {
          const rows = await transaction.$queryRawUnsafe<
            Array<{
              activeReleases: bigint;
              draftVersion: number;
              releases: bigint;
              revisions: bigint;
            }>
          >(
            `SELECT project."draftVersion",
                    (SELECT COUNT(*) FROM "ProjectRevision"
                      WHERE "projectId" = project."id")::bigint
                      AS "revisions",
                    (SELECT COUNT(*) FROM "Release"
                      WHERE "projectId" = project."id")::bigint
                      AS "releases",
                    (SELECT COUNT(*) FROM "ActiveRelease"
                      WHERE "projectId" = project."id")::bigint
                      AS "activeReleases"
               FROM "Project" AS project
              WHERE project."id" = $1`,
            id,
          );
          return (
            rows[0]?.draftVersion === 2 &&
            rows[0]?.revisions === 2n &&
            rows[0]?.releases === 1n &&
            rows[0]?.activeReleases === 1n
          );
        },
        probe,
        resourceId: id,
        workspaceId: owner.workspaceId,
      }),
    });

    try {
      const failed = await publishRequest(
        failingApp,
        owner,
        id,
        operationId,
        1,
        fixture('v4-bundled-images-valid.json'),
      ).expect(500);
      expect(errorCode(failed)).toBe('INTERNAL_SERVER_ERROR');
      expect(JSON.stringify(responseBody(failed))).not.toContain(
        'private marker',
      );
    } finally {
      await failingApp.close();
    }

    expect(probe).toEqual({
      auditAttempted: true,
      businessWritesObserved: true,
      auditWriteObserved: true,
    });
    await expect(persistedProjectSnapshot(pool, id)).resolves.toEqual(before);
    await expect(artifactCounts(pool, id)).resolves.toEqual({
      revisions: 1,
      releases: 0,
      activeReleases: 0,
    });
    await expect(idempotencyRows(pool, [operationId])).resolves.toEqual([]);
    await expect(auditRows(pool, owner.workspaceId)).resolves.toEqual(
      auditBefore,
    );
    await expect(auditSequenceNextValue(pool)).resolves.toBe(sequenceBefore);
  });

  it('publishes one immutable release and makes it active with the draft revision atomically', async () => {
    const publishedConfig = fixture('v4-bundled-images-valid.json');
    const created = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    ).expect(201);
    const id = projectId(created);
    const operationId = uniqueKey128('publish-boundary');
    const published = await publishRequest(
      app,
      owner,
      id,
      operationId,
      1,
      publishedConfig,
    ).expect(200);
    const releaseId = releaseIdFromResponse(published);

    const project = await pool.query<{
      draft: unknown;
      draftSchemaVersion: number;
      draftVersion: number;
    }>(
      `SELECT "draft", "draftSchemaVersion", "draftVersion"
         FROM "Project" WHERE "id" = $1`,
      [id],
    );
    expect(project.rows).toEqual([
      {
        draft: publishedConfig,
        draftSchemaVersion: 4,
        draftVersion: 2,
      },
    ]);
    const revisions = await pool.query<{
      operationId: string;
      schemaVersion: number;
      siteConfig: unknown;
      version: number;
    }>(
      `SELECT "operationId", "version", "schemaVersion", "siteConfig"
         FROM "ProjectRevision" WHERE "projectId" = $1 ORDER BY "version"`,
      [id],
    );
    expect(revisions.rows.map(({ version }) => version)).toEqual([1, 2]);
    const publishedRevision = revisions.rows[1];
    if (publishedRevision === undefined) {
      throw new Error('Expected published revision');
    }
    expect(publishedRevision).toMatchObject({
      version: 2,
      schemaVersion: 4,
      siteConfig: publishedConfig,
    });
    expect(publishedRevision.operationId.length).toBeGreaterThan(0);
    expect(
      new Set(revisions.rows.map(({ operationId }) => operationId)).size,
    ).toBe(2);
    const releases = await pool.query<{
      id: string;
      operationId: string;
      schemaVersion: number;
      siteConfig: unknown;
      version: number;
    }>(
      `SELECT "id", "operationId", "version", "schemaVersion", "siteConfig"
         FROM "Release" WHERE "projectId" = $1`,
      [id],
    );
    expect(releases.rows).toHaveLength(1);
    const storedRelease = releases.rows[0];
    if (storedRelease === undefined) throw new Error('Expected stored release');
    expect(storedRelease).toMatchObject({
      id: releaseId,
      version: 2,
      schemaVersion: 4,
      siteConfig: publishedConfig,
    });
    expect(storedRelease.operationId.length).toBeGreaterThan(0);
    expect(storedRelease.operationId).toBe(publishedRevision.operationId);
    await expect(activeRelease(pool, id)).resolves.toMatchObject({ releaseId });

    const replayRows = await idempotencyRows(pool, [operationId]);
    expect(replayRows).toHaveLength(1);
    expect(replayRows[0]).toMatchObject({
      key: operationId,
      httpStatus: 200,
      resourceId: releaseId,
    });
    const replayRow = replayRows[0];
    if (replayRow === undefined) throw new Error('Expected publish replay row');
    await expect(idempotencyIdentityCount(pool, replayRow)).resolves.toBe(1);
    expect(JSON.stringify(replayRows[0]?.responseBody)).not.toContain(
      'siteConfig',
    );
    const audits = await auditRows(pool, owner.workspaceId);
    expect(audits).toHaveLength(1);
    const audit = audits[0];
    if (audit === undefined) throw new Error('Expected publish audit event');
    expectSafeAuditEvent(
      audit,
      owner,
      [id, releaseId],
      [responseRequestId(published)],
    );
  });

  it('stores a stale new publish key as a replayable conflict without moving revision, release, activation, or audit state', async () => {
    const created = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    ).expect(201);
    const id = projectId(created);
    await publishRequest(
      app,
      owner,
      id,
      randomUUID(),
      1,
      fixture('v4-bundled-images-valid.json'),
    ).expect(200);
    const beforeArtifacts = await persistedProjectSnapshot(pool, id);
    const beforeActive = await activeRelease(pool, id);
    const staleKey = randomUUID();
    const staleConfig = namedSiteConfig(
      fixture('v4-minimal-valid.json'),
      'Stale publish',
    );

    const stale = await publishRequest(
      app,
      owner,
      id,
      staleKey,
      1,
      staleConfig,
    ).expect(409);
    expect(errorCode(stale)).toBe('PROJECT_VERSION_CONFLICT');
    const storedConflictStatus = stale.status;
    const storedConflictBody = normalizedServerRequestIds(responseBody(stale));
    await expect(persistedProjectSnapshot(pool, id)).resolves.toEqual(
      beforeArtifacts,
    );
    await expect(activeRelease(pool, id)).resolves.toEqual(beforeActive);

    await saveDraftRequest(
      app,
      owner,
      id,
      randomUUID(),
      2,
      namedSiteConfig(
        fixture('v4-bundled-images-valid.json'),
        'Draft advanced after stored conflict',
      ),
    ).expect(200);
    const afterAdvance = await persistedProjectSnapshot(pool, id);
    expect(afterAdvance).not.toEqual(beforeArtifacts);
    const activeAfterAdvance = await activeRelease(pool, id);

    const replay = await publishRequest(
      app,
      owner,
      id,
      staleKey,
      1,
      reorderJson(staleConfig),
    ).expect(409);
    expect(errorCode(replay)).toBe('PROJECT_VERSION_CONFLICT');
    expect(replay.status).toBe(storedConflictStatus);
    expect(normalizedServerRequestIds(responseBody(replay))).toEqual(
      storedConflictBody,
    );

    await expect(persistedProjectSnapshot(pool, id)).resolves.toEqual(
      afterAdvance,
    );
    await expect(activeRelease(pool, id)).resolves.toEqual(activeAfterAdvance);
    const stored = await idempotencyRows(pool, [staleKey]);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      key: staleKey,
      httpStatus: 409,
    });
    const storedBody = stored[0]?.responseBody;
    if (!isRecord(storedBody)) throw new Error('Expected stored conflict body');
    expect(storedBody['code']).toBe('PROJECT_VERSION_CONFLICT');
    const storedConflict = stored[0];
    if (storedConflict === undefined) {
      throw new Error('Expected stored publish conflict');
    }
    await expect(idempotencyIdentityCount(pool, storedConflict)).resolves.toBe(
      1,
    );
    await expect(auditRows(pool, owner.workspaceId)).resolves.toHaveLength(1);
  });

  it('serializes concurrent same-key publishes into identical results and one revision, release, pointer, audit, and replay row', async () => {
    const created = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    ).expect(201);
    const id = projectId(created);
    const operationId = randomUUID();
    const publishedConfig = fixture('v4-bundled-images-valid.json');
    const raceGate = await installDatabaseRaceGate(pool, id, 'Project');
    const pointerWrites = await installPointerWriteProbe(pool, id);
    try {
      const firstPromise = Promise.resolve(
        publishRequest(app, owner, id, operationId, 1, publishedConfig),
      );
      await raceGate.waitUntilBlocked();
      const secondPromise = Promise.resolve(
        publishRequest(
          app,
          owner,
          id,
          operationId,
          1,
          reorderJson(publishedConfig),
        ),
      );
      await waitForAdvisoryLock(
        pool,
        idempotencyAdvisoryLockId({
          scope: `workspace:${owner.workspaceId}:project:${id}`,
          operation: 'PUBLISH_PROJECT',
          key: operationId,
        }),
        false,
      );
      await raceGate.release();
      const [first, second] = await Promise.all([firstPromise, secondPromise]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(responseBody(first)).toEqual(responseBody(second));
      const releaseId = releaseIdFromResponse(first);
      await expect(artifactCounts(pool, id)).resolves.toEqual({
        revisions: 2,
        releases: 1,
        activeReleases: 1,
      });
      await expect(activeRelease(pool, id)).resolves.toMatchObject({
        releaseId,
      });
      await expect(pointerWrites.read()).resolves.toBe(1);
      await expectOneStoredIdentity(pool, operationId);
      const audits = await auditRows(pool, owner.workspaceId);
      expect(audits).toHaveLength(1);
      const audit = audits[0];
      if (audit === undefined) throw new Error('Expected publish audit event');
      expectSafeAuditEvent(
        audit,
        owner,
        [id, releaseId],
        [responseRequestId(first), responseRequestId(second)],
      );
    } finally {
      await raceGate.dispose();
      await pointerWrites.dispose();
    }
  });

  it('scopes the same idempotency key independently by project, workspace, and publish-versus-activate operation', async () => {
    const firstCreated = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    ).expect(201);
    const secondCreated = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    ).expect(201);
    const thirdCreated = await createProjectRequest(
      app,
      otherOwner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    ).expect(201);
    const firstProjectId = projectId(firstCreated);
    const secondProjectId = projectId(secondCreated);
    const thirdProjectId = projectId(thirdCreated);
    const sharedKey = uniqueKey128('cross-scope-operation');

    const firstPublished = await publishRequest(
      app,
      owner,
      firstProjectId,
      sharedKey,
      1,
      namedSiteConfig(
        fixture('v4-bundled-images-valid.json'),
        'First scoped publish',
      ),
    ).expect(200);
    const firstReleaseId = releaseIdFromResponse(firstPublished);
    const secondPublished = await publishRequest(
      app,
      owner,
      secondProjectId,
      sharedKey,
      1,
      namedSiteConfig(
        fixture('v4-bundled-images-valid.json'),
        'Second scoped publish',
      ),
    ).expect(200);
    const secondReleaseId = releaseIdFromResponse(secondPublished);
    const thirdPublished = await publishRequest(
      app,
      otherOwner,
      thirdProjectId,
      sharedKey,
      1,
      namedSiteConfig(
        fixture('v4-bundled-images-valid.json'),
        'Third workspace scoped publish',
      ),
    ).expect(200);
    const thirdReleaseId = releaseIdFromResponse(thirdPublished);
    await publishRequest(
      app,
      owner,
      firstProjectId,
      randomUUID(),
      2,
      namedSiteConfig(fixture('v4-minimal-valid.json'), 'Later active release'),
    ).expect(200);
    const activated = await activateRequest(
      app,
      owner,
      firstProjectId,
      firstReleaseId,
      sharedKey,
    ).expect(200);
    expect(releaseIdFromResponse(activated)).toBe(firstReleaseId);

    const stored = await idempotencyRows(pool, [sharedKey]);
    expect(stored).toHaveLength(4);
    expect(stored.every(({ key }) => key === sharedKey)).toBe(true);
    expect(stored.every(({ httpStatus }) => httpStatus === 200)).toBe(true);
    expect(new Set(stored.map(idempotencyIdentity)).size).toBe(4);
    expect(stored.map(({ resourceId }) => resourceId).sort()).toEqual(
      [firstReleaseId, firstReleaseId, secondReleaseId, thirdReleaseId].sort(),
    );
    const rowsByOperation = new Map<string, IdempotencyRow[]>();
    for (const row of stored) {
      const rows = rowsByOperation.get(row.operation) ?? [];
      rows.push(row);
      rowsByOperation.set(row.operation, rows);
    }
    expect(
      [...rowsByOperation.values()].map(({ length }) => length).sort(),
    ).toEqual([1, 3]);
    const repeatedOperationRows = [...rowsByOperation.values()].find(
      ({ length }) => length === 3,
    );
    if (repeatedOperationRows === undefined) {
      throw new Error('Expected publish operation in three project scopes');
    }
    expect(new Set(repeatedOperationRows.map(({ scope }) => scope)).size).toBe(
      3,
    );
    for (const row of stored) {
      await expect(idempotencyIdentityCount(pool, row)).resolves.toBe(1);
    }
    await expect(activeRelease(pool, firstProjectId)).resolves.toMatchObject({
      releaseId: firstReleaseId,
    });
    await expect(artifactCounts(pool, firstProjectId)).resolves.toEqual({
      revisions: 3,
      releases: 2,
      activeReleases: 1,
    });
    await expect(artifactCounts(pool, secondProjectId)).resolves.toEqual({
      revisions: 2,
      releases: 1,
      activeReleases: 1,
    });
    await expect(artifactCounts(pool, thirdProjectId)).resolves.toEqual({
      revisions: 2,
      releases: 1,
      activeReleases: 1,
    });
  });

  it('replays the original publish result after response loss even when the draft later advances', async () => {
    const created = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    ).expect(201);
    const id = projectId(created);
    const lostResponseKey = randomUUID();
    const publishedConfig = fixture('v4-bundled-images-valid.json');
    const first = await publishRequest(
      app,
      owner,
      id,
      lostResponseKey,
      1,
      publishedConfig,
    ).expect(200);
    const originalReleaseId = releaseIdFromResponse(first);

    await saveDraftRequest(
      app,
      owner,
      id,
      randomUUID(),
      2,
      namedSiteConfig(fixture('v4-minimal-valid.json'), 'Later draft'),
    ).expect(200);
    const pointerBeforeRetry = await activeRelease(pool, id);
    const retried = await publishRequest(
      app,
      owner,
      id,
      lostResponseKey,
      1,
      reorderJson(publishedConfig),
    ).expect(200);

    expect(responseBody(retried)).toEqual(responseBody(first));
    expect(releaseIdFromResponse(retried)).toBe(originalReleaseId);
    await expect(artifactCounts(pool, id)).resolves.toEqual({
      revisions: 3,
      releases: 1,
      activeReleases: 1,
    });
    await expect(activeRelease(pool, id)).resolves.toEqual(pointerBeforeRetry);
    expect(pointerBeforeRetry).toMatchObject({ releaseId: originalReleaseId });
    await expectOneStoredIdentity(pool, lostResponseKey);
    await expect(auditRows(pool, owner.workspaceId)).resolves.toHaveLength(1);
  });

  it('rejects a publish key reused with changed semantic payload without any write or pointer movement', async () => {
    const created = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    ).expect(201);
    const id = projectId(created);
    const operationId = randomUUID();
    await publishRequest(
      app,
      owner,
      id,
      operationId,
      1,
      fixture('v4-bundled-images-valid.json'),
    ).expect(200);
    const before = await persistedProjectSnapshot(pool, id);
    const beforeActive = await activeRelease(pool, id);

    const reused = await publishRequest(
      app,
      owner,
      id,
      operationId,
      1,
      namedSiteConfig(fixture('v4-minimal-valid.json'), 'Changed publish'),
    ).expect(409);
    expect(errorCode(reused)).toBe('IDEMPOTENCY_KEY_REUSED');
    await expect(persistedProjectSnapshot(pool, id)).resolves.toEqual(before);
    await expect(activeRelease(pool, id)).resolves.toEqual(beforeActive);
    await expectOneStoredIdentity(pool, operationId);
    await expect(auditRows(pool, owner.workspaceId)).resolves.toHaveLength(1);
  });

  it('allows one publish winner when different keys race at the same expected version and stores both outcomes', async () => {
    const created = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    ).expect(201);
    const id = projectId(created);
    const firstKey = randomUUID();
    const secondKey = randomUUID();
    const firstConfig = namedSiteConfig(
      fixture('v4-bundled-images-valid.json'),
      'First racer',
    );
    const secondConfig = namedSiteConfig(
      fixture('v4-bundled-images-valid.json'),
      'Second racer',
    );

    const raceGate = await installDatabaseRaceGate(pool, id, 'Project');
    let responses: readonly request.Response[];
    try {
      const firstPromise = Promise.resolve(
        publishRequest(app, owner, id, firstKey, 1, firstConfig),
      );
      await raceGate.waitUntilBlocked();
      const secondPromise = Promise.resolve(
        publishRequest(app, owner, id, secondKey, 1, secondConfig),
      );
      await waitForAdvisoryLock(
        pool,
        idempotencyAdvisoryLockId({
          scope: `workspace:${owner.workspaceId}:project:${id}`,
          operation: 'PUBLISH_PROJECT',
          key: secondKey,
        }),
        true,
      );
      await raceGate.release();
      responses = await Promise.all([firstPromise, secondPromise]);
    } finally {
      await raceGate.dispose();
    }
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const rejected = responses.find(({ status }) => status === 409);
    expect(rejected === undefined ? undefined : errorCode(rejected)).toBe(
      'PROJECT_VERSION_CONFLICT',
    );
    await expect(artifactCounts(pool, id)).resolves.toEqual({
      revisions: 2,
      releases: 1,
      activeReleases: 1,
    });
    const stored = await idempotencyRows(pool, [firstKey, secondKey]);
    expect(stored).toHaveLength(2);
    expect(stored.map(({ httpStatus }) => httpStatus).sort()).toEqual([
      200, 409,
    ]);
    for (const row of stored) {
      await expect(idempotencyIdentityCount(pool, row)).resolves.toBe(1);
    }
    await expect(auditRows(pool, owner.workspaceId)).resolves.toHaveLength(1);

    const persisted = await pool.query<{ draft: unknown; siteConfig: unknown }>(
      `SELECT project."draft", release."siteConfig"
         FROM "Project" AS project
         JOIN "Release" AS release ON release."projectId" = project."id"
        WHERE project."id" = $1`,
      [id],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]?.draft).toEqual(persisted.rows[0]?.siteConfig);
    expect([firstConfig, secondConfig]).toContainEqual(
      persisted.rows[0]?.siteConfig,
    );
  });

  it('hides foreign workspace, user, project, and release combinations behind one 404 contract without pointer movement', async () => {
    const ownerProjectResponse = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    ).expect(201);
    const ownerProjectId = projectId(ownerProjectResponse);
    const foreignProject = await seedReleasedProject(pool, otherOwner, [
      fixture('v4-bundled-images-valid.json'),
    ]);
    const foreignRelease = foreignProject.releases[0];
    if (foreignRelease === undefined)
      throw new Error('Expected foreign release');

    const wrongUser = await publishForWorkspaceRequest(
      app,
      otherOwner,
      owner.workspaceId,
      ownerProjectId,
      randomUUID(),
      1,
      fixture('v4-bundled-images-valid.json'),
    ).expect(404);
    const wrongWorkspace = await publishForWorkspaceRequest(
      app,
      otherOwner,
      otherOwner.workspaceId,
      ownerProjectId,
      randomUUID(),
      1,
      fixture('v4-bundled-images-valid.json'),
    ).expect(404);
    expect(errorCode(wrongUser)).toBe('NOT_FOUND');
    expect(errorCode(wrongWorkspace)).toBe('NOT_FOUND');

    const ownPublish = await publishRequest(
      app,
      owner,
      ownerProjectId,
      randomUUID(),
      1,
      fixture('v4-bundled-images-valid.json'),
    ).expect(200);
    const ownReleaseId = releaseIdFromResponse(ownPublish);
    const pointerBefore = await activeRelease(pool, ownerProjectId);
    const projectBeforeForeignActivations = await persistedProjectSnapshot(
      pool,
      ownerProjectId,
    );
    const foreignUserActivation = await activateRequest(
      app,
      otherOwner,
      ownerProjectId,
      ownReleaseId,
      randomUUID(),
      owner.workspaceId,
    ).expect(404);
    const foreignWorkspaceActivation = await activateRequest(
      app,
      otherOwner,
      ownerProjectId,
      ownReleaseId,
      randomUUID(),
      otherOwner.workspaceId,
    ).expect(404);
    const crossProjectRelease = await activateRequest(
      app,
      owner,
      ownerProjectId,
      foreignRelease.id,
      randomUUID(),
    ).expect(404);
    expect(errorCode(foreignUserActivation)).toBe('NOT_FOUND');
    expect(errorCode(foreignWorkspaceActivation)).toBe('NOT_FOUND');
    expect(errorCode(crossProjectRelease)).toBe('NOT_FOUND');
    await expect(activeRelease(pool, ownerProjectId)).resolves.toEqual(
      pointerBefore,
    );
    await expect(activeRelease(pool, ownerProjectId)).resolves.toMatchObject({
      releaseId: ownReleaseId,
    });
    await expect(
      persistedProjectSnapshot(pool, ownerProjectId),
    ).resolves.toEqual(projectBeforeForeignActivations);
    await expect(artifactCounts(pool, ownerProjectId)).resolves.toEqual({
      revisions: 2,
      releases: 1,
      activeReleases: 1,
    });
    await expect(auditRows(pool, owner.workspaceId)).resolves.toHaveLength(1);
  });

  it('rolls back pointer, replay, audit event, and audit sequence when activation audit append fails after the pointer write', async () => {
    const project = await seedReleasedProject(
      pool,
      owner,
      [
        fixture('v4-minimal-valid.json'),
        fixture('v4-bundled-images-valid.json'),
      ],
      0,
    );
    const firstRelease = project.releases[0];
    const secondRelease = project.releases[1];
    if (firstRelease === undefined || secondRelease === undefined) {
      throw new Error('Expected activation rollback fixtures');
    }
    const operationId = uniqueKey128('activate-audit-failure');
    const immutableBefore = await persistedProjectSnapshot(pool, project.id);
    const pointerBefore = await activeRelease(pool, project.id);
    const auditBefore = await auditRows(pool, owner.workspaceId);
    const sequenceBefore = await auditSequenceNextValue(pool);
    const probe: RollbackAuditProbe = {
      auditAttempted: false,
      auditWriteObserved: false,
      businessWritesObserved: false,
    };
    const failingApp = await createApplication({
      auditFactory: transactionalFailingAuditFactory({
        action: 'TEST_ACTIVATE_ROLLBACK',
        actorUserId: owner.userId,
        businessProbe: async (transaction) => {
          const rows = await transaction.$queryRawUnsafe<
            Array<{
              activeReleaseId: string | null;
              releases: bigint;
              revisions: bigint;
            }>
          >(
            `SELECT
               (SELECT "releaseId" FROM "ActiveRelease"
                 WHERE "projectId" = $1) AS "activeReleaseId",
               (SELECT COUNT(*) FROM "Release"
                 WHERE "projectId" = $1)::bigint AS "releases",
               (SELECT COUNT(*) FROM "ProjectRevision"
                 WHERE "projectId" = $1)::bigint AS "revisions"`,
            project.id,
          );
          return (
            rows[0]?.activeReleaseId === secondRelease.id &&
            rows[0]?.releases === 2n &&
            rows[0]?.revisions === 2n
          );
        },
        probe,
        resourceId: secondRelease.id,
        workspaceId: owner.workspaceId,
      }),
    });

    try {
      const failed = await activateRequest(
        failingApp,
        owner,
        project.id,
        secondRelease.id,
        operationId,
      ).expect(500);
      expect(errorCode(failed)).toBe('INTERNAL_SERVER_ERROR');
      expect(JSON.stringify(responseBody(failed))).not.toContain(
        'private marker',
      );
    } finally {
      await failingApp.close();
    }

    expect(probe).toEqual({
      auditAttempted: true,
      auditWriteObserved: true,
      businessWritesObserved: true,
    });
    await expect(persistedProjectSnapshot(pool, project.id)).resolves.toEqual(
      immutableBefore,
    );
    await expect(activeRelease(pool, project.id)).resolves.toEqual(
      pointerBefore,
    );
    await expect(activeRelease(pool, project.id)).resolves.toMatchObject({
      releaseId: firstRelease.id,
    });
    await expect(idempotencyRows(pool, [operationId])).resolves.toEqual([]);
    await expect(auditRows(pool, owner.workspaceId)).resolves.toEqual(
      auditBefore,
    );
    await expect(auditSequenceNextValue(pool)).resolves.toBe(sequenceBefore);
  });

  it('serializes concurrent same-key activation into one stored result and one pointer and audit change', async () => {
    const project = await seedReleasedProject(
      pool,
      owner,
      [
        fixture('v4-minimal-valid.json'),
        fixture('v4-bundled-images-valid.json'),
      ],
      0,
    );
    const firstRelease = project.releases[0];
    const secondRelease = project.releases[1];
    if (firstRelease === undefined || secondRelease === undefined) {
      throw new Error('Expected two release fixtures');
    }
    const operationId = randomUUID();
    const immutableBefore = await persistedProjectSnapshot(pool, project.id);
    const pointerBefore = await activeRelease(pool, project.id);
    const pointerWrites = await installPointerWriteProbe(pool, project.id);
    const raceGate = await installDatabaseRaceGate(
      pool,
      project.id,
      'ActiveRelease',
    );
    try {
      const firstPromise = Promise.resolve(
        activateRequest(app, owner, project.id, secondRelease.id, operationId),
      );
      await raceGate.waitUntilBlocked();
      const secondPromise = Promise.resolve(
        activateRequest(app, owner, project.id, secondRelease.id, operationId),
      );
      await waitForAdvisoryLock(
        pool,
        idempotencyAdvisoryLockId({
          scope: `workspace:${owner.workspaceId}:project:${project.id}`,
          operation: 'ACTIVATE_RELEASE',
          key: operationId,
        }),
        false,
      );
      await raceGate.release();
      const [first, second] = await Promise.all([firstPromise, secondPromise]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(responseBody(first)).toEqual(responseBody(second));
      expect(releaseIdFromResponse(first)).toBe(secondRelease.id);
      await expect(persistedProjectSnapshot(pool, project.id)).resolves.toEqual(
        immutableBefore,
      );
      const pointerAfter = await activeRelease(pool, project.id);
      expect(pointerAfter).toMatchObject({ releaseId: secondRelease.id });
      expect(pointerAfter?.activatedAt).not.toEqual(pointerBefore?.activatedAt);
      await expect(pointerWrites.read()).resolves.toBe(1);
      await expectOneStoredIdentity(pool, operationId);
      const audits = await auditRows(pool, owner.workspaceId);
      expect(audits).toHaveLength(1);
      const audit = audits[0];
      if (audit === undefined)
        throw new Error('Expected activation audit event');
      expectSafeAuditEvent(
        audit,
        owner,
        [project.id, secondRelease.id],
        [responseRequestId(first), responseRequestId(second)],
      );
    } finally {
      await raceGate.dispose();
      await pointerWrites.dispose();
    }
  });

  it('replays the original activation after response loss without undoing a later successful activation', async () => {
    const project = await seedReleasedProject(
      pool,
      owner,
      [
        fixture('v4-minimal-valid.json'),
        fixture('v4-bundled-images-valid.json'),
        namedSiteConfig(fixture('v4-minimal-valid.json'), 'Third release'),
      ],
      0,
    );
    const secondRelease = project.releases[1];
    const thirdRelease = project.releases[2];
    if (secondRelease === undefined || thirdRelease === undefined) {
      throw new Error('Expected three release fixtures');
    }
    const lostResponseKey = randomUUID();
    const laterKey = randomUUID();
    const immutableBefore = await persistedProjectSnapshot(pool, project.id);

    const original = await activateRequest(
      app,
      owner,
      project.id,
      secondRelease.id,
      lostResponseKey,
    ).expect(200);
    await activateRequest(
      app,
      owner,
      project.id,
      thirdRelease.id,
      laterKey,
    ).expect(200);
    const laterPointer = await activeRelease(pool, project.id);
    const replay = await activateRequest(
      app,
      owner,
      project.id,
      secondRelease.id,
      lostResponseKey,
    ).expect(200);

    expect(responseBody(replay)).toEqual(responseBody(original));
    expect(releaseIdFromResponse(replay)).toBe(secondRelease.id);
    await expect(activeRelease(pool, project.id)).resolves.toEqual(
      laterPointer,
    );
    await expect(activeRelease(pool, project.id)).resolves.toMatchObject({
      releaseId: thirdRelease.id,
    });
    await expect(persistedProjectSnapshot(pool, project.id)).resolves.toEqual(
      immutableBefore,
    );
    const stored = await idempotencyRows(pool, [lostResponseKey, laterKey]);
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      await expect(idempotencyIdentityCount(pool, row)).resolves.toBe(1);
    }
    await expect(auditRows(pool, owner.workspaceId)).resolves.toHaveLength(2);
  });

  it('rejects an activation key reused for another release without moving the pointer', async () => {
    const project = await seedReleasedProject(
      pool,
      owner,
      [
        fixture('v4-minimal-valid.json'),
        fixture('v4-bundled-images-valid.json'),
      ],
      0,
    );
    const firstRelease = project.releases[0];
    const secondRelease = project.releases[1];
    if (firstRelease === undefined || secondRelease === undefined) {
      throw new Error('Expected two release fixtures');
    }
    const operationId = randomUUID();
    await activateRequest(
      app,
      owner,
      project.id,
      secondRelease.id,
      operationId,
    ).expect(200);
    const pointerBeforeReuse = await activeRelease(pool, project.id);
    const immutableBeforeReuse = await persistedProjectSnapshot(
      pool,
      project.id,
    );

    const reused = await activateRequest(
      app,
      owner,
      project.id,
      firstRelease.id,
      operationId,
    ).expect(409);
    expect(errorCode(reused)).toBe('IDEMPOTENCY_KEY_REUSED');
    await expect(activeRelease(pool, project.id)).resolves.toEqual(
      pointerBeforeReuse,
    );
    await expect(activeRelease(pool, project.id)).resolves.toMatchObject({
      releaseId: secondRelease.id,
    });
    await expect(persistedProjectSnapshot(pool, project.id)).resolves.toEqual(
      immutableBeforeReuse,
    );
    await expectOneStoredIdentity(pool, operationId);
    await expect(auditRows(pool, owner.workspaceId)).resolves.toHaveLength(1);
  });

  it('serves anonymous root and page snapshots with privacy data, no internal leakage, and a stable conditional ETag', async () => {
    const siteConfig = fixture('v4-shared-chrome-valid.json');
    const project = await seedReleasedProject(pool, owner, [siteConfig]);
    const release = project.releases[0];
    if (release === undefined) throw new Error('Expected active release');

    const root = await publicSiteRequest(app, project.publicSlug).expect(200);
    expectPublicRepresentation(root, release, configuration);
    const firstEtag = responseEtag(root);
    const repeated = await publicSiteRequest(app, project.publicSlug).expect(
      200,
    );
    expect(responseBody(repeated)).toEqual(responseBody(root));
    expect(responseEtag(repeated)).toBe(firstEtag);
    const conditional = await publicSiteRequest(app, project.publicSlug)
      .set('If-None-Match', firstEtag)
      .expect(304);
    expect(responseEtag(conditional)).toBe(firstEtag);

    const page = await publicPageRequest(
      app,
      project.publicSlug,
      'shared-2',
    ).expect(200);
    expectPublicRepresentation(page, release, configuration, 'shared-2');
    const pageEtag = responseEtag(page);
    expect(responseBody(page)).not.toEqual(responseBody(root));
    expect(pageEtag).not.toBe(firstEtag);
    const repeatedPage = await publicPageRequest(
      app,
      project.publicSlug,
      'shared-2',
    ).expect(200);
    expect(responseBody(repeatedPage)).toEqual(responseBody(page));
    expect(responseEtag(repeatedPage)).toBe(pageEtag);
    const conditionalPage = await publicPageRequest(
      app,
      project.publicSlug,
      'shared-2',
    )
      .set('If-None-Match', pageEtag)
      .expect(304);
    expect(responseEtag(conditionalPage)).toBe(pageEtag);
    await publicPageRequest(app, project.publicSlug, 'shared-2')
      .set('If-None-Match', firstEtag)
      .expect(200);
    await publicSiteRequest(app, project.publicSlug)
      .set('If-None-Match', pageEtag)
      .expect(200);
  });

  it('returns the uniform not-found envelope for a percent-encoded NUL public slug', async () => {
    const malformed = await publicSiteRequest(app, '%00').expect(404);

    expect(errorCode(malformed)).toBe('NOT_FOUND');
    expect(Object.keys(responseBody(malformed))).toEqual(['error']);
  });

  it('keeps public output and its ETag immutable when later draft edits advance the project', async () => {
    const releasedConfig = fixture('v4-minimal-valid.json');
    const laterDraft = namedSiteConfig(
      fixture('v4-bundled-images-valid.json'),
      'Unpublished later draft',
    );
    const project = await seedReleasedProject(pool, owner, [releasedConfig]);
    const release = project.releases[0];
    if (release === undefined) throw new Error('Expected active release');
    const before = await publicSiteRequest(app, project.publicSlug).expect(200);
    const beforeEtag = responseEtag(before);
    const pageBefore = await publicPageRequest(
      app,
      project.publicSlug,
      'minimal',
    ).expect(200);
    const pageBeforeEtag = responseEtag(pageBefore);

    await saveDraftRequest(
      app,
      owner,
      project.id,
      randomUUID(),
      1,
      laterDraft,
    ).expect(200);
    const after = await publicSiteRequest(app, project.publicSlug).expect(200);
    const pageAfter = await publicPageRequest(
      app,
      project.publicSlug,
      'minimal',
    ).expect(200);

    expect(responseBody(after)).toEqual(responseBody(before));
    expect(responseEtag(after)).toBe(beforeEtag);
    expectPublicRepresentation(after, release, configuration);
    expect(responseBody(pageAfter)).toEqual(responseBody(pageBefore));
    expect(responseEtag(pageAfter)).toBe(pageBeforeEtag);
    expectPublicRepresentation(pageAfter, release, configuration, 'minimal');
    const stored = await pool.query<{
      draft: unknown;
      draftVersion: number;
      releaseConfig: unknown;
    }>(
      `SELECT project."draft", project."draftVersion",
              release."siteConfig" AS "releaseConfig"
         FROM "Project" AS project
         JOIN "Release" AS release ON release."id" = $2
        WHERE project."id" = $1`,
      [project.id, release.id],
    );
    expect(stored.rows).toEqual([
      {
        draft: laterDraft,
        draftVersion: 2,
        releaseConfig: releasedConfig,
      },
    ]);
  });

  it('moves only ActiveRelease between identical-content releases while root and page ETags follow release identity', async () => {
    const sharedConfig = fixture('v4-minimal-valid.json');
    const project = await seedReleasedProject(
      pool,
      owner,
      [sharedConfig, sharedConfig],
      1,
    );
    const oldRelease = project.releases[0];
    const newRelease = project.releases[1];
    if (oldRelease === undefined || newRelease === undefined) {
      throw new Error('Expected rollback release fixtures');
    }
    expect(oldRelease.id).not.toBe(newRelease.id);
    expect(oldRelease.version).not.toBe(newRelease.version);
    expect(oldRelease.siteConfig).toEqual(newRelease.siteConfig);
    const immutableBefore = await persistedProjectSnapshot(pool, project.id);
    const before = await publicSiteRequest(app, project.publicSlug).expect(200);
    expectPublicRepresentation(before, newRelease, configuration);
    const beforeEtag = responseEtag(before);
    const pageBefore = await publicPageRequest(
      app,
      project.publicSlug,
      'minimal',
    ).expect(200);
    expectPublicRepresentation(
      pageBefore,
      newRelease,
      configuration,
      'minimal',
    );
    const pageBeforeEtag = responseEtag(pageBefore);
    const rollbackKey = randomUUID();

    const rollback = await activateRequest(
      app,
      owner,
      project.id,
      oldRelease.id,
      rollbackKey,
    ).expect(200);
    expect(releaseIdFromResponse(rollback)).toBe(oldRelease.id);
    const after = await publicSiteRequest(app, project.publicSlug).expect(200);
    const pageAfter = await publicPageRequest(
      app,
      project.publicSlug,
      'minimal',
    ).expect(200);

    expectPublicRepresentation(after, oldRelease, configuration);
    expect(responseBody(after)).not.toEqual(responseBody(before));
    expect(responseEtag(after)).not.toBe(beforeEtag);
    expectPublicRepresentation(pageAfter, oldRelease, configuration, 'minimal');
    expect(responseBody(pageAfter)).not.toEqual(responseBody(pageBefore));
    expect(responseEtag(pageAfter)).not.toBe(pageBeforeEtag);
    await expect(activeRelease(pool, project.id)).resolves.toMatchObject({
      releaseId: oldRelease.id,
    });
    await expect(persistedProjectSnapshot(pool, project.id)).resolves.toEqual(
      immutableBefore,
    );
    await expectOneStoredIdentity(pool, rollbackKey);
    await expect(auditRows(pool, owner.workspaceId)).resolves.toHaveLength(1);
  });

  it('resolves public data through the slug and composite active release identity and gives one 404 envelope for every unknown resource', async () => {
    const ownProject = await seedReleasedProject(pool, owner, [
      fixture('v4-minimal-valid.json'),
    ]);
    const foreignProject = await seedReleasedProject(pool, otherOwner, [
      fixture('v4-bundled-images-valid.json'),
    ]);
    const noActiveProject = await seedReleasedProject(
      pool,
      owner,
      [fixture('v4-minimal-valid.json')],
      null,
    );
    const ownRelease = ownProject.releases[0];
    const foreignRelease = foreignProject.releases[0];
    if (ownRelease === undefined || foreignRelease === undefined) {
      throw new Error('Expected tenant release fixtures');
    }

    const known = await publicSiteRequest(app, ownProject.publicSlug).expect(
      200,
    );
    expectPublicRepresentation(known, ownRelease, configuration);
    expect(JSON.stringify(responseBody(known))).not.toContain(
      foreignRelease.id,
    );

    const missingSlug = await publicSiteRequest(app, `missing-${randomUUID()}`);
    const noActive = await publicSiteRequest(app, noActiveProject.publicSlug);
    const missingPage = await publicPageRequest(
      app,
      ownProject.publicSlug,
      'unknown-page',
    );
    const foreignPage = await publicPageRequest(
      app,
      ownProject.publicSlug,
      'home',
    );

    const expectedNotFound = normalizedNotFound(missingSlug);
    expect(normalizedNotFound(noActive)).toEqual(expectedNotFound);
    expect(normalizedNotFound(missingPage)).toEqual(expectedNotFound);
    expect(normalizedNotFound(foreignPage)).toEqual(expectedNotFound);
    expect(errorCode(missingSlug)).toBe('NOT_FOUND');
  });
});
