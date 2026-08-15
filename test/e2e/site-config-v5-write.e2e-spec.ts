import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool, type PoolClient } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import {
  APP_CONFIG,
  type AppConfig,
  loadAppConfig,
} from '../../src/shared/config/app-config.schema';
import {
  SITECONFIG_ROLLOUT_LOCK_ID,
  SITE_CONFIG_ROLLOUT_STATE_KEY,
} from '../../src/modules/sites/infrastructure/site-config-rollout-guard';

jest.setTimeout(30_000);

const allowedOrigin = 'http://localhost:4200';
const accessTokenSecret = 'test-access-token-secret-32-bytes';

interface TestIdentity {
  readonly accessToken: string;
  readonly email: string;
  readonly userId: string;
  readonly workspaceId: string;
}

interface StoredProjectVersions {
  readonly draft: unknown;
  readonly draftSchemaVersion: number;
  readonly releaseVersions: number[];
  readonly revisionDocuments: unknown[];
  readonly revisionVersions: number[];
}

function databaseUrlFor(databaseUrl: string, databaseName: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${databaseName}`;
  parsed.searchParams.delete('schema');
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z0-9_]+$/u.test(identifier)) {
    throw new Error('Unsafe temporary database identifier');
  }
  return `"${identifier}"`;
}

async function applyMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const root = resolve('prisma/migrations');
    for (const directory of readdirSync(root).sort()) {
      const migration = resolve(root, directory, 'migration.sql');
      if (existsSync(migration)) {
        await pool.query(readFileSync(migration, 'utf8'));
      }
    }
  } finally {
    await pool.end();
  }
}

async function createApplication(
  configuration: AppConfig,
): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(APP_CONFIG)
    .useValue(configuration)
    .compile();
  const app = moduleFixture.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  await app.init();
  return app;
}

function fixture(name: string): Record<string, unknown> {
  const value: unknown = JSON.parse(
    readFileSync(resolve('contracts/site-config/fixtures', name), 'utf8'),
  );
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Fixture ${name} is not an object`);
  }
  return value as Record<string, unknown>;
}

function mediaNeutralV5Fixture(): Record<string, unknown> {
  const config = fixture('v5-managed-valid.json');
  const pages = config['pages'];
  const page: unknown = Array.isArray(pages)
    ? (pages as unknown[])[0]
    : undefined;
  const blocks =
    typeof page === 'object' && page !== null && !Array.isArray(page)
      ? (page as Record<string, unknown>)['blocks']
      : undefined;
  const hero: unknown = Array.isArray(blocks)
    ? (blocks as unknown[])[0]
    : undefined;
  if (typeof hero !== 'object' || hero === null || Array.isArray(hero)) {
    throw new Error('Managed v5 fixture has no hero');
  }
  (hero as Record<string, unknown>)['media'] = {
    kind: 'external',
    src: 'https://media.example.test/rollout.webp',
    alt: 'Rollout media',
  };
  return config;
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

async function seedIdentity(pool: Pool): Promise<TestIdentity> {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const email = `rollout-${userId}@example.test`;
  await pool.query(
    `INSERT INTO "User"
       ("id", "email", "passwordHash", "emailVerifiedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, 'not-used-by-rollout-test', now(), now(), now())`,
    [userId, email],
  );
  await pool.query(
    `INSERT INTO "Workspace" ("id", "name", "createdAt", "updatedAt")
     VALUES ($1, 'Rollout workspace', now(), now())`,
    [workspaceId],
  );
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

function createProjectRequest(
  app: INestApplication<App>,
  identity: TestIdentity,
  siteConfig: unknown,
): request.Test {
  return request(app.getHttpServer())
    .post(`/v1/workspaces/${identity.workspaceId}/projects`)
    .set('Authorization', `Bearer ${identity.accessToken}`)
    .set('Origin', allowedOrigin)
    .set('Idempotency-Key', randomUUID())
    .send({ name: 'Rollout project', siteConfig });
}

async function siteWriteCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT
       (SELECT COUNT(*) FROM "Project")
       + (SELECT COUNT(*) FROM "ProjectRevision")
       + (SELECT COUNT(*) FROM "Release")
       + (SELECT COUNT(*) FROM "IdempotencyRecord") AS count`,
  );
  return Number(result.rows[0]?.count ?? '-1');
}

async function waitForAdvisoryLockWaiter(pool: Pool): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND wait_event = 'advisory'
       ) AS waiting`,
    );
    if (result.rows[0]?.waiting === true) return true;
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 10);
    });
  }
  return false;
}

async function activateV5(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO "SiteConfigRolloutState" ("key", "v5ActivatedAt")
     VALUES ($1, CURRENT_TIMESTAMP)`,
    [SITE_CONFIG_ROLLOUT_STATE_KEY],
  );
}

describe('SiteConfig v5 persisted write rollout', () => {
  let adminPool: Pool;
  let pool: Pool;
  let v4Application: INestApplication<App> | undefined;
  let v5Application: INestApplication<App> | undefined;
  let identity: TestIdentity;
  let testDatabaseName: string;
  let v4Configuration: AppConfig;
  let v5Configuration: AppConfig;

  beforeAll(async () => {
    const baseDatabaseUrl = process.env['DATABASE_URL'];
    if (baseDatabaseUrl === undefined) {
      throw new Error('DATABASE_URL is required for rollout E2E');
    }
    testDatabaseName = `nexus_v5_${process.pid}_${randomUUID().replaceAll('-', '')}`;
    adminPool = new Pool({
      connectionString: databaseUrlFor(baseDatabaseUrl, 'postgres'),
    });
    await adminPool.query(
      `CREATE DATABASE ${quoteIdentifier(testDatabaseName)} TEMPLATE template0`,
    );
    const testDatabaseUrl = databaseUrlFor(baseDatabaseUrl, testDatabaseName);
    await applyMigrations(testDatabaseUrl);
    pool = new Pool({ connectionString: testDatabaseUrl });
    identity = await seedIdentity(pool);
    const baseConfiguration = loadAppConfig();
    v4Configuration = {
      ...baseConfiguration,
      databaseUrl: testDatabaseUrl,
      siteConfigRolloutMode: 'V4_COMPAT',
    };
    v5Configuration = {
      ...baseConfiguration,
      databaseUrl: testDatabaseUrl,
      siteConfigRolloutMode: 'V5_ACTIVE',
    };
  });

  afterAll(async () => {
    await v4Application?.close();
    await v5Application?.close();
    await pool?.end();
    if (adminPool !== undefined && testDatabaseName !== undefined) {
      await adminPool.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(testDatabaseName)} WITH (FORCE)`,
      );
      await adminPool.end();
    }
  });

  it('rejects v5 input before a transaction in V4_COMPAT', async () => {
    v4Application = await createApplication(v4Configuration);
    await request(v4Application.getHttpServer())
      .get('/v1/health/ready')
      .expect(200);
    await createProjectRequest(
      v4Application,
      identity,
      mediaNeutralV5Fixture(),
    ).expect(400);
    await expect(siteWriteCount(pool)).resolves.toBe(0);
    await v4Application.close();
    v4Application = undefined;
  });

  it('fails closed before activation, then writes create/save/publish as v5', async () => {
    v5Application = await createApplication(v5Configuration);
    await request(v5Application.getHttpServer())
      .get('/v1/health/ready')
      .expect(503);
    await createProjectRequest(
      v5Application,
      identity,
      fixture('v4-minimal-valid.json'),
    ).expect(500);
    await expect(siteWriteCount(pool)).resolves.toBe(0);

    const activation = await pool.connect();
    let activationCommitted = false;
    let firstWriteSettled = false;
    let firstWrite: Promise<request.Response> | undefined;
    try {
      await activation.query('BEGIN');
      await activation.query('SELECT pg_advisory_xact_lock($1::bigint)', [
        SITECONFIG_ROLLOUT_LOCK_ID.toString(),
      ]);
      firstWrite = createProjectRequest(
        v5Application,
        identity,
        fixture('v4-bundled-dot-images-valid.json'),
      ).then((response) => {
        firstWriteSettled = true;
        return response;
      });
      await expect(waitForAdvisoryLockWaiter(pool)).resolves.toBe(true);
      expect(firstWriteSettled).toBe(false);
      await activateV5(activation);
      await activation.query('COMMIT');
      activationCommitted = true;
    } finally {
      if (!activationCommitted) await activation.query('ROLLBACK');
      activation.release();
    }

    if (firstWrite === undefined)
      throw new Error('First v5 write was not started');
    const created = await firstWrite;
    expect(created.status).toBe(201);
    const createdBody = created.body as Record<string, unknown>;
    expect(createdBody['draftSchemaVersion']).toBe(5);
    const projectId = createdBody['id'];
    if (typeof projectId !== 'string') throw new Error('Expected project id');

    const saved = await request(v5Application.getHttpServer())
      .put(`/v1/workspaces/${identity.workspaceId}/projects/${projectId}/draft`)
      .set('Authorization', `Bearer ${identity.accessToken}`)
      .set('Origin', allowedOrigin)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedDraftVersion: 1,
        siteConfig: mediaNeutralV5Fixture(),
      })
      .expect(200);
    expect((saved.body as Record<string, unknown>)['draftSchemaVersion']).toBe(
      5,
    );

    const published = await request(v5Application.getHttpServer())
      .post(
        `/v1/workspaces/${identity.workspaceId}/projects/${projectId}/publish`,
      )
      .set('Authorization', `Bearer ${identity.accessToken}`)
      .set('Origin', allowedOrigin)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedDraftVersion: 2,
        siteConfig: fixture('v4-full-valid.json'),
      })
      .expect(200);
    expect((published.body as Record<string, unknown>)['schemaVersion']).toBe(
      5,
    );

    const stored = await pool.query<StoredProjectVersions>(
      `SELECT project."draft",
              project."draftSchemaVersion" AS "draftSchemaVersion",
              ARRAY(
                SELECT revision."schemaVersion"
                  FROM "ProjectRevision" AS revision
                 WHERE revision."projectId" = project."id"
                 ORDER BY revision."version"
              ) AS "revisionVersions",
              ARRAY(
                SELECT revision."siteConfig"
                  FROM "ProjectRevision" AS revision
                 WHERE revision."projectId" = project."id"
                 ORDER BY revision."version"
              ) AS "revisionDocuments",
              ARRAY(
                SELECT release."schemaVersion"
                  FROM "Release" AS release
                 WHERE release."projectId" = project."id"
                 ORDER BY release."version"
              ) AS "releaseVersions"
         FROM "Project" AS project
        WHERE project."id" = $1`,
      [projectId],
    );
    expect(stored.rows).toHaveLength(1);
    const state = stored.rows[0];
    if (state === undefined) throw new Error('Expected stored project state');
    expect(state.draftSchemaVersion).toBe(5);
    expect(state.revisionVersions).toEqual([5, 5, 5]);
    expect(state.releaseVersions).toEqual([5]);
    expect(JSON.stringify(state.revisionDocuments[0])).toContain(
      '"kind":"bundled"',
    );
    expect(JSON.stringify(state.revisionDocuments[1])).toContain(
      '"src":"https://media.example.test/rollout.webp"',
    );
    expect(JSON.stringify(state.draft)).toContain('"schemaVersion":5');
    await request(v5Application.getHttpServer())
      .get('/v1/health/ready')
      .expect(200);
  });
});
