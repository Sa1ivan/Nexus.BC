import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { APP_CONFIG } from '../../src/shared/config/app-config.schema';
import type { PrismaClient } from '../../src/generated/prisma/client';
import {
  buildProjectMediaObjectKey,
  OBJECT_STORAGE,
  type BoundedObjectReadResult,
  type ObjectStorage,
  type ObjectStorageKey,
} from '../../src/modules/media/application/ports/object-storage';
import { PrismaClientService } from '../../src/shared/database/prisma.service';
import {
  createV5TestDatabase,
  type V5TestDatabase,
} from './support/v5-test-database';

const allowedOrigin = 'http://localhost:4200';
const accessTokenSecret = 'test-access-token-secret-32-bytes';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const pngChecksum = createHash('sha256').update(png).digest('hex');

jest.setTimeout(20_000);

interface TestIdentity {
  readonly accessToken: string;
  readonly projectId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

interface SeededAsset {
  readonly assetId: string;
  readonly key: ObjectStorageKey;
}

interface DatabaseRaceGate {
  dispose(): Promise<void>;
  release(): Promise<void>;
  waitUntilBlocked(): Promise<number>;
}

type ReferenceKind =
  'active-release' | 'current-draft' | 'inactive-release' | 'retained-revision';

class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<ObjectStorageKey, Uint8Array>();
  readonly deleted: ObjectStorageKey[] = [];
  readonly failNextDelete = new Set<ObjectStorageKey>();

  createPresignedPut(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }

  createPresignedGet(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }

  head(key: ObjectStorageKey) {
    const bytes = this.objects.get(key);
    return Promise.resolve(
      bytes === undefined
        ? ({ kind: 'not-found' } as const)
        : ({
            kind: 'found',
            metadata: {
              contentLength: bytes.byteLength,
              contentType: 'image/png',
            },
          } as const),
    );
  }

  readBounded(input: {
    readonly key: ObjectStorageKey;
    readonly maxBytes: number;
  }): Promise<BoundedObjectReadResult> {
    const bytes = this.objects.get(input.key);
    return Promise.resolve(
      bytes === undefined
        ? ({ kind: 'not-found' } as const)
        : ({
            kind: 'found',
            metadata: {
              contentLength: bytes.byteLength,
              contentType: 'image/png',
            },
            body: Readable.from([bytes]),
          } as const),
    );
  }

  delete(key: ObjectStorageKey): Promise<void> {
    if (this.failNextDelete.delete(key)) {
      return Promise.reject(new Error('simulated storage deletion failure'));
    }
    this.deleted.push(key);
    this.objects.delete(key);
    return Promise.resolve();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fixture(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    readFileSync(resolve('contracts/site-config/fixtures', name), 'utf8'),
  );
  if (!isRecord(parsed)) throw new Error(`Fixture ${name} is not an object`);
  return parsed;
}

function managedMedia(assetId: string, alt: string): Record<string, unknown> {
  return { kind: 'managed', assetId, alt };
}

function managedConfig(
  firstAssetId: string,
  nonFirstAssetId = firstAssetId,
): Record<string, unknown> {
  const config = structuredClone(fixture('v5-managed-valid.json'));
  const business = config['business'];
  if (!isRecord(business)) throw new Error('Managed fixture has no business');
  business['logo'] = managedMedia(firstAssetId, 'Managed logo');
  const pages = config['pages'];
  if (!Array.isArray(pages) || !isRecord(pages[0])) {
    throw new Error('Managed fixture has no first page');
  }
  const blocks = pages[0]['blocks'];
  if (!Array.isArray(blocks) || !isRecord(blocks[0])) {
    throw new Error('Managed fixture has no first block');
  }
  blocks[0]['media'] = managedMedia(firstAssetId, 'Managed hero');
  const secondPage = structuredClone(pages[0]);
  secondPage['id'] = 'page-secondary';
  secondPage['slug'] = 'secondary';
  secondPage['title'] = 'Secondary';
  const secondBlocks = secondPage['blocks'];
  if (!Array.isArray(secondBlocks) || !isRecord(secondBlocks[0])) {
    throw new Error('Managed fixture has no secondary hero');
  }
  const secondHero = structuredClone(secondBlocks[0]);
  secondHero['id'] = 'hero-secondary';
  secondHero['anchor'] = 'secondary-hero';
  secondHero['media'] = managedMedia(nonFirstAssetId, 'Managed secondary hero');
  secondPage['blocks'] = [secondHero];
  pages.push(secondPage);
  return config;
}

function errorCode(response: request.Response): unknown {
  const body: unknown = response.body;
  if (!isRecord(body) || !isRecord(body['error'])) return undefined;
  return body['error']['code'];
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
): Promise<number> {
  const parts = advisoryLockParts(lockId);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await pool.query<{ pid: number }>(
      `SELECT waiting.pid
         FROM pg_locks waiting
        WHERE waiting.locktype = 'advisory'
          AND waiting.classid::bigint = $1::bigint
          AND waiting.objid::bigint = $2::bigint
          AND waiting.granted = false`,
      [parts.classId, parts.objectId],
    );
    const pid = result.rows[0]?.pid;
    if (pid !== undefined) return pid;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('Timed out waiting for the deterministic race gate');
}

async function waitUntilBlockedBy(
  pool: Pool,
  blockerPid: number,
): Promise<number> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await pool.query<{ pid: number }>(
      `SELECT pid
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND state = 'active'
          AND wait_event_type = 'Lock'
          AND $1::integer = ANY(pg_blocking_pids(pid))`,
      [blockerPid],
    );
    const pid = result.rows[0]?.pid;
    if (pid !== undefined) return pid;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(
    `Timed out waiting for a contender blocked by PID ${blockerPid}`,
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 3_000,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error(`${label} did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function settleRaceOperations(
  pool: Pool,
  operations: readonly Promise<request.Response>[],
  backendPids: readonly number[],
): Promise<void> {
  const settled = Promise.allSettled(operations);
  try {
    await withTimeout(settled, 'race cleanup settlement', 1_500);
  } catch (error) {
    const exactPids = [...new Set(backendPids)];
    if (exactPids.length === 0) throw error;
    await pool.query(
      `SELECT pg_terminate_backend(pid)
         FROM unnest($1::integer[]) AS exact_backend(pid)
        WHERE pid <> pg_backend_pid()`,
      [exactPids],
    );
    await withTimeout(settled, 'terminated race settlement', 1_500);
  }
}

async function installDatabaseRaceGate(
  pool: Pool,
  projectId: string,
  target: 'MediaAsset' | 'Project',
): Promise<DatabaseRaceGate> {
  const token = randomUUID().replaceAll('-', '');
  const functionName = `p106_race_gate_${token}`;
  const triggerName = `p106_wait_race_${token}`;
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
    const cleanup = await pool.connect();
    try {
      await release();
      await cleanup.query(`SET lock_timeout = '750ms'`);
      await cleanup.query(`SET statement_timeout = '1s'`);
      if (triggerCreated) {
        await cleanup.query(
          `DROP TRIGGER IF EXISTS "${triggerName}" ON "${target}"`,
        );
      }
    } finally {
      try {
        if (functionCreated) {
          await cleanup.query(`DROP FUNCTION IF EXISTS "${functionName}"()`);
        }
      } finally {
        cleanup.release();
        controller.release();
      }
    }
  };

  try {
    await controller.query('SELECT pg_advisory_lock($1::bigint)', [
      lockId.toString(),
    ]);
    lockHeld = true;
    const projectExpression =
      target === 'Project'
        ? 'NEW."id"'
        : `CASE WHEN TG_OP = 'DELETE' THEN OLD."projectId" ELSE NEW."projectId" END`;
    await pool.query(
      `CREATE FUNCTION "${functionName}"() RETURNS trigger
       LANGUAGE plpgsql AS $p106$
       BEGIN
         IF (${projectExpression})::text = TG_ARGV[0] THEN
           PERFORM pg_advisory_xact_lock(TG_ARGV[1]::bigint);
         END IF;
         IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
         RETURN NEW;
       END
       $p106$`,
    );
    functionCreated = true;
    const event = target === 'Project' ? 'UPDATE' : 'UPDATE OR DELETE';
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
    waitUntilBlocked: () => waitForAdvisoryLock(pool, lockId),
  };
}

describe('managed media save/publish versus deletion serialization', () => {
  let app: INestApplication<App>;
  let pool: Pool;
  let prisma: PrismaClient;
  let storage: MemoryObjectStorage;
  let testDatabase: V5TestDatabase;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];

  beforeAll(async () => {
    testDatabase = await createV5TestDatabase('nexus_media_race');
    pool = testDatabase.pool;
    storage = new MemoryObjectStorage();
    const builder = Test.createTestingModule({ imports: [AppModule] });
    builder.overrideProvider(APP_CONFIG).useValue(testDatabase.configuration);
    builder.overrideProvider(OBJECT_STORAGE).useValue(storage);
    const moduleFixture = await builder.compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    await app.init();
    prisma = app.get<PrismaClient>(PrismaClientService);
  });

  afterEach(async () => {
    if (workspaceIds.length === 0) return;
    await prisma.idempotencyRecord.deleteMany({
      where: {
        OR: workspaceIds.map((workspaceId) => ({
          scope: { startsWith: `workspace:${workspaceId}` },
        })),
      },
    });
    await prisma.activeRelease.deleteMany({
      where: { project: { workspaceId: { in: workspaceIds } } },
    });
    await prisma.release.deleteMany({
      where: { project: { workspaceId: { in: workspaceIds } } },
    });
    await prisma.projectRevision.deleteMany({
      where: { project: { workspaceId: { in: workspaceIds } } },
    });
    await prisma.mediaAsset.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await prisma.project.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await prisma.membership.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await prisma.workspace.deleteMany({
      where: { id: { in: workspaceIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    storage.deleted.length = 0;
    storage.objects.clear();
    userIds.length = 0;
    workspaceIds.length = 0;
  });

  afterAll(async () => {
    try {
      const residue = await pool.query<{ name: string }>(
        `SELECT tgname AS name
           FROM pg_trigger
          WHERE tgname LIKE 'p106_%'
          UNION ALL
         SELECT proname AS name
           FROM pg_proc
          WHERE proname LIKE 'p106_%'
          UNION ALL
         SELECT tablename AS name
           FROM pg_tables
          WHERE tablename LIKE 'p106_%'`,
      );
      expect(residue.rows).toEqual([]);
    } finally {
      await app.close();
      await testDatabase.dispose();
    }
  });

  async function seedIdentity(label: string): Promise<TestIdentity> {
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const email = `${label}-${userId}@example.test`;
    const initial = fixture('v4-minimal-valid.json');
    const operationId = randomUUID();
    userIds.push(userId);
    workspaceIds.push(workspaceId);
    await prisma.user.create({
      data: {
        id: userId,
        email,
        passwordHash: 'not-used-by-media-race',
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.workspace.create({
      data: { id: workspaceId, name: `${label} workspace` },
    });
    await prisma.membership.create({
      data: { userId, workspaceId, role: 'OWNER' },
    });
    await prisma.project.create({
      data: {
        id: projectId,
        workspaceId,
        createOperationId: operationId,
        name: `${label} project`,
        publicSlug: `media-race-${randomUUID()}`,
        draft: initial,
        draftSchemaVersion: 4,
        revisions: {
          create: {
            operationId,
            version: 1,
            siteConfig: initial,
            schemaVersion: 4,
          },
        },
      },
    });
    return {
      userId,
      workspaceId,
      projectId,
      accessToken: signAccessToken(userId, email),
    };
  }

  async function seedReadyAsset(identity: TestIdentity): Promise<SeededAsset> {
    const assetId = randomUUID();
    const key = buildProjectMediaObjectKey({
      workspaceId: identity.workspaceId,
      projectId: identity.projectId,
      assetId,
      safeName: 'hero.png',
    });
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        workspaceId: identity.workspaceId,
        projectId: identity.projectId,
        objectKey: key,
        status: 'READY',
        declaredFileName: 'hero.png',
        declaredMimeType: 'image/png',
        declaredSizeBytes: png.byteLength,
        declaredChecksumSha256: pngChecksum,
        verifiedMimeType: 'image/png',
        verifiedSizeBytes: png.byteLength,
        verifiedWidth: 1,
        verifiedHeight: 1,
        verifiedChecksumSha256: pngChecksum,
        verifiedAt: new Date(),
      },
    });
    storage.objects.set(key, png);
    return { assetId, key };
  }

  function headers(
    test: request.Test,
    identity: TestIdentity,
    operationId = randomUUID(),
  ): request.Test {
    return test
      .set('Authorization', `Bearer ${identity.accessToken}`)
      .set('Origin', allowedOrigin)
      .set('Idempotency-Key', operationId);
  }

  function deleteRequest(
    identity: TestIdentity,
    assetId: string,
  ): Promise<request.Response> {
    return headers(
      request(app.getHttpServer()).delete(
        `/v1/workspaces/${identity.workspaceId}/projects/${identity.projectId}/media/${assetId}`,
      ),
      identity,
    );
  }

  function publishRequest(
    identity: TestIdentity,
    firstAssetId: string,
    nonFirstAssetId = firstAssetId,
  ): Promise<request.Response> {
    return headers(
      request(app.getHttpServer()).post(
        `/v1/workspaces/${identity.workspaceId}/projects/${identity.projectId}/publish`,
      ),
      identity,
    ).send({
      expectedDraftVersion: 1,
      siteConfig: managedConfig(firstAssetId, nonFirstAssetId),
    });
  }

  function saveRequest(
    identity: TestIdentity,
    firstAssetId: string,
    nonFirstAssetId = firstAssetId,
  ): Promise<request.Response> {
    return headers(
      request(app.getHttpServer()).put(
        `/v1/workspaces/${identity.workspaceId}/projects/${identity.projectId}/draft`,
      ),
      identity,
    ).send({
      expectedDraftVersion: 1,
      siteConfig: managedConfig(firstAssetId, nonFirstAssetId),
    });
  }

  async function seedReference(
    identity: TestIdentity,
    assetId: string,
    kind: ReferenceKind,
  ): Promise<void> {
    const siteConfig = managedConfig(assetId);
    if (kind === 'current-draft') {
      await prisma.project.update({
        where: { id: identity.projectId },
        data: { draft: siteConfig, draftSchemaVersion: 5 },
      });
      return;
    }
    if (kind === 'retained-revision') {
      await prisma.projectRevision.create({
        data: {
          projectId: identity.projectId,
          operationId: randomUUID(),
          version: 2,
          siteConfig,
          schemaVersion: 5,
        },
      });
      await prisma.projectRevision.create({
        data: {
          projectId: identity.projectId,
          operationId: randomUUID(),
          version: 3,
          siteConfig: fixture('v4-minimal-valid.json'),
          schemaVersion: 4,
        },
      });
      return;
    }
    const release = await prisma.release.create({
      data: {
        projectId: identity.projectId,
        operationId: randomUUID(),
        version: 2,
        siteConfig,
        schemaVersion: 5,
      },
    });
    if (kind === 'active-release') {
      await prisma.activeRelease.create({
        data: { projectId: identity.projectId, releaseId: release.id },
      });
      return;
    }
    const newerCleanRelease = await prisma.release.create({
      data: {
        projectId: identity.projectId,
        operationId: randomUUID(),
        version: 3,
        siteConfig: fixture('v4-minimal-valid.json'),
        schemaVersion: 4,
      },
    });
    await prisma.activeRelease.create({
      data: {
        projectId: identity.projectId,
        releaseId: newerCleanRelease.id,
      },
    });
  }

  async function orderedRace(input: {
    readonly contender: () => Promise<request.Response>;
    readonly first: () => Promise<request.Response>;
    readonly identity: TestIdentity;
    readonly target: 'MediaAsset' | 'Project';
  }): Promise<readonly [request.Response, request.Response]> {
    const gate = await installDatabaseRaceGate(
      pool,
      input.identity.projectId,
      input.target,
    );
    const first = Promise.resolve(input.first());
    let contender: Promise<request.Response> | undefined;
    let firstPid: number | undefined;
    let contenderPid: number | undefined;
    try {
      firstPid = await withTimeout(
        gate.waitUntilBlocked(),
        'first gated operation',
      );
      contender = Promise.resolve(input.contender());
      contenderPid = await withTimeout(
        waitUntilBlockedBy(pool, firstPid),
        'exact blocked contender',
      );
      await gate.release();
      return withTimeout(
        Promise.all([first, contender]),
        'ordered race operations',
      );
    } catch (error) {
      await gate.release();
      await settleRaceOperations(
        pool,
        contender === undefined ? [first] : [first, contender],
        [firstPid, contenderPid].filter(
          (pid): pid is number => pid !== undefined,
        ),
      );
      throw error;
    } finally {
      await withTimeout(gate.dispose(), 'race gate teardown', 3_000);
    }
  }

  it.each([
    ['current draft', 'current-draft'],
    ['retained revision history', 'retained-revision'],
    ['active release', 'active-release'],
    [
      'inactive release retained as a rollback or lead-linked candidate',
      'inactive-release',
    ],
  ] satisfies readonly (readonly [string, ReferenceKind])[])(
    'rejects deletion for a reference in the %s and leaves row/object unchanged',
    async (_label, kind) => {
      const identity = await seedIdentity(`delete-${kind}`);
      const asset = await seedReadyAsset(identity);
      await seedReference(identity, asset.assetId, kind);
      const before = await prisma.mediaAsset.findUniqueOrThrow({
        where: { id: asset.assetId },
      });

      const response = await deleteRequest(identity, asset.assetId);

      expect(response.status).toBe(409);
      expect(errorCode(response)).toBe('MEDIA_ASSET_IN_USE');
      await expect(
        prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.assetId } }),
      ).resolves.toEqual(before);
      expect(storage.objects.get(asset.key)).toEqual(png);
      expect(storage.deleted).not.toContain(asset.key);
    },
  );

  it('returns repeat-safe 202 until storage deletion succeeds, then stable 204', async () => {
    const identity = await seedIdentity('delete-retry');
    const asset = await seedReadyAsset(identity);
    storage.failNextDelete.add(asset.key);

    const pending = await deleteRequest(identity, asset.assetId);

    expect(pending.status).toBe(202);
    expect(storage.objects.get(asset.key)).toEqual(png);
    const marked = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: asset.assetId },
    });
    expect(marked.status).toBe('DELETING');
    expect(marked.deletionMarkedAt).toBeInstanceOf(Date);
    await expect(
      prisma.auditEvent.count({
        where: {
          resourceId: asset.assetId,
          action: 'MEDIA_DELETION_MARKED',
        },
      }),
    ).resolves.toBe(1);

    expect((await deleteRequest(identity, asset.assetId)).status).toBe(204);
    expect((await deleteRequest(identity, asset.assetId)).status).toBe(204);
    expect(storage.objects.has(asset.key)).toBe(false);
    await expect(
      prisma.auditEvent.count({
        where: {
          resourceId: asset.assetId,
          action: 'MEDIA_DELETION_MARKED',
        },
      }),
    ).resolves.toBe(1);
  });

  it.each(['site-first', 'delete-first'] as const)(
    'deterministically serializes publish versus delete with %s',
    async (winner) => {
      const identity = await seedIdentity(`publish-delete-${winner}`);
      const assets = [
        await seedReadyAsset(identity),
        await seedReadyAsset(identity),
      ].sort((left, right) => right.assetId.localeCompare(left.assetId));
      const firstReference = assets[0];
      const deletedAsset = assets[1];
      if (firstReference === undefined || deletedAsset === undefined) {
        throw new Error('Expected two managed race assets');
      }
      const publish = () =>
        publishRequest(identity, firstReference.assetId, deletedAsset.assetId);
      const remove = () => deleteRequest(identity, deletedAsset.assetId);

      const [first, contender] = await orderedRace({
        identity,
        target: winner === 'site-first' ? 'Project' : 'MediaAsset',
        first: winner === 'site-first' ? publish : remove,
        contender: winner === 'site-first' ? remove : publish,
      });
      const published = winner === 'site-first' ? first : contender;
      const deleted = winner === 'site-first' ? contender : first;

      expect(published.status).toBe(winner === 'site-first' ? 200 : 409);
      expect(errorCode(published)).toBe(
        winner === 'site-first' ? undefined : 'MEDIA_ASSET_NOT_READY',
      );
      expect(deleted.status).toBe(winner === 'site-first' ? 409 : 204);
      expect(errorCode(deleted)).toBe(
        winner === 'site-first' ? 'MEDIA_ASSET_IN_USE' : undefined,
      );
      await expect(
        prisma.release.count({ where: { projectId: identity.projectId } }),
      ).resolves.toBe(winner === 'site-first' ? 1 : 0);
      await expect(
        prisma.activeRelease.count({
          where: { projectId: identity.projectId },
        }),
      ).resolves.toBe(winner === 'site-first' ? 1 : 0);
      await expect(
        prisma.projectRevision.count({
          where: { projectId: identity.projectId },
        }),
      ).resolves.toBe(winner === 'site-first' ? 2 : 1);
      await expect(
        prisma.project.findUniqueOrThrow({
          where: { id: identity.projectId },
          select: { draftVersion: true },
        }),
      ).resolves.toEqual({
        draftVersion: winner === 'site-first' ? 2 : 1,
      });
      const storedAsset = await prisma.mediaAsset.findUnique({
        where: { id: deletedAsset.assetId },
      });
      expect(
        winner === 'delete-first'
          ? storedAsset === null ||
              (storedAsset.status === 'DELETING' &&
                storedAsset.deletionMarkedAt instanceof Date)
          : storedAsset?.status === 'READY' &&
              storedAsset.deletionMarkedAt === null,
      ).toBe(true);
      expect(storage.objects.has(deletedAsset.key)).toBe(
        winner === 'site-first',
      );
      expect(storage.deleted.includes(deletedAsset.key)).toBe(
        winner === 'delete-first',
      );
      expect(storage.objects.get(firstReference.key)).toEqual(png);
    },
  );

  it.each(['site-first', 'delete-first'] as const)(
    'deterministically serializes draft save versus delete with %s',
    async (winner) => {
      const identity = await seedIdentity(`save-delete-${winner}`);
      const assets = [
        await seedReadyAsset(identity),
        await seedReadyAsset(identity),
      ].sort((left, right) => right.assetId.localeCompare(left.assetId));
      const firstReference = assets[0];
      const deletedAsset = assets[1];
      if (firstReference === undefined || deletedAsset === undefined) {
        throw new Error('Expected two managed race assets');
      }
      const save = () =>
        saveRequest(identity, firstReference.assetId, deletedAsset.assetId);
      const remove = () => deleteRequest(identity, deletedAsset.assetId);

      const [first, contender] = await orderedRace({
        identity,
        target: winner === 'site-first' ? 'Project' : 'MediaAsset',
        first: winner === 'site-first' ? save : remove,
        contender: winner === 'site-first' ? remove : save,
      });
      const saved = winner === 'site-first' ? first : contender;
      const deleted = winner === 'site-first' ? contender : first;

      expect(saved.status).toBe(winner === 'site-first' ? 200 : 409);
      expect(errorCode(saved)).toBe(
        winner === 'site-first' ? undefined : 'MEDIA_ASSET_NOT_READY',
      );
      expect(deleted.status).toBe(winner === 'site-first' ? 409 : 204);
      expect(errorCode(deleted)).toBe(
        winner === 'site-first' ? 'MEDIA_ASSET_IN_USE' : undefined,
      );
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: identity.projectId },
        select: { draftVersion: true },
      });
      expect(project.draftVersion).toBe(winner === 'site-first' ? 2 : 1);
      await expect(
        prisma.projectRevision.count({
          where: { projectId: identity.projectId },
        }),
      ).resolves.toBe(winner === 'site-first' ? 2 : 1);
      const storedAsset = await prisma.mediaAsset.findUnique({
        where: { id: deletedAsset.assetId },
      });
      expect(
        winner === 'delete-first'
          ? storedAsset === null ||
              (storedAsset.status === 'DELETING' &&
                storedAsset.deletionMarkedAt instanceof Date)
          : storedAsset?.status === 'READY' &&
              storedAsset.deletionMarkedAt === null,
      ).toBe(true);
      expect(storage.objects.has(deletedAsset.key)).toBe(
        winner === 'site-first',
      );
      expect(storage.deleted.includes(deletedAsset.key)).toBe(
        winner === 'delete-first',
      );
      expect(storage.objects.get(firstReference.key)).toEqual(png);
    },
  );
});
