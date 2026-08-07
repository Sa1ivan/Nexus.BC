import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspect } from 'node:util';
import type { INestApplication, LoggerService } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import {
  APP_CONFIG,
  type AppConfig,
  loadAppConfig,
} from '../../src/shared/config/app-config.schema';

const allowedOrigin = 'http://localhost:4200';
const accessTokenSecret = 'test-access-token-secret-32-bytes';

interface TestIdentity {
  readonly accessToken: string;
  readonly email: string;
  readonly userId: string;
  readonly workspaceId: string;
}

interface SiteCounts {
  readonly idempotencyRecords: number;
  readonly projects: number;
  readonly revisions: number;
}

interface StoredIdempotencySnapshot {
  readonly requestFingerprint: string;
  readonly responseBody: string;
}

class CapturingLogger implements LoggerService {
  constructor(private readonly messages: string[]) {}

  log(message: unknown, ...optionalParameters: unknown[]): void {
    this.capture(message, optionalParameters);
  }

  error(message: unknown, ...optionalParameters: unknown[]): void {
    this.capture(message, optionalParameters);
  }

  warn(message: unknown, ...optionalParameters: unknown[]): void {
    this.capture(message, optionalParameters);
  }

  debug(message: unknown, ...optionalParameters: unknown[]): void {
    this.capture(message, optionalParameters);
  }

  verbose(message: unknown, ...optionalParameters: unknown[]): void {
    this.capture(message, optionalParameters);
  }

  fatal(message: unknown, ...optionalParameters: unknown[]): void {
    this.capture(message, optionalParameters);
  }

  private capture(message: unknown, optionalParameters: unknown[]): void {
    this.messages.push(
      [message, ...optionalParameters]
        .map((value) =>
          typeof value === 'string'
            ? value
            : inspect(value, {
                breakLength: Number.POSITIVE_INFINITY,
                colors: false,
                depth: null,
              }),
        )
        .join(' '),
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseBody(response: request.Response): Record<string, unknown> {
  const body: unknown = response.body;
  if (!isRecord(body)) throw new Error('Expected an object response body');
  return body;
}

function errorCode(response: request.Response): unknown {
  const body = responseBody(response);
  const error = body['error'];
  return isRecord(error) ? error['code'] : undefined;
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
  logs: string[],
  configuration?: AppConfig,
): Promise<INestApplication<App>> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (configuration !== undefined) {
    builder.overrideProvider(APP_CONFIG).useValue(configuration);
  }
  const moduleFixture = await builder.compile();
  const app = moduleFixture.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  app.useLogger(new CapturingLogger(logs));
  await app.init();
  return app;
}

async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM "IdempotencyRecord"');
  await pool.query('DELETE FROM "Project"');
  await pool.query('DELETE FROM "Membership"');
  await pool.query('DELETE FROM "Workspace"');
  await pool.query('DELETE FROM "User"');
}

async function seedIdentity(pool: Pool, label: string): Promise<TestIdentity> {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const email = `${label}-${userId}@example.test`;
  await pool.query(
    `INSERT INTO "User"
       ("id", "email", "passwordHash", "emailVerifiedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, 'not-used-by-sites-contract', now(), now(), now())`,
    [userId, email],
  );
  await pool.query(
    `INSERT INTO "Workspace" ("id", "name", "createdAt", "updatedAt")
     VALUES ($1, $2, now(), now())`,
    [workspaceId, `${label} workspace`],
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

async function siteCounts(pool: Pool): Promise<SiteCounts> {
  const result = await pool.query<{
    idempotencyRecords: string;
    projects: string;
    revisions: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM "IdempotencyRecord") AS "idempotencyRecords",
       (SELECT COUNT(*) FROM "Project") AS "projects",
       (SELECT COUNT(*) FROM "ProjectRevision") AS "revisions"`,
  );
  const counts = result.rows[0];
  if (counts === undefined) throw new Error('Expected site row counts');
  return {
    idempotencyRecords: Number(counts.idempotencyRecords),
    projects: Number(counts.projects),
    revisions: Number(counts.revisions),
  };
}

function createProjectRequest(
  app: INestApplication<App>,
  identity: TestIdentity,
  operationId: string,
  siteConfig: unknown,
  name = 'Cloud project',
): request.Test {
  return request(app.getHttpServer())
    .post(`/v1/workspaces/${identity.workspaceId}/projects`)
    .set(authorize(identity))
    .set('Origin', allowedOrigin)
    .set('Idempotency-Key', operationId)
    .send({ name, siteConfig });
}

function saveDraftRequest(
  app: INestApplication<App>,
  identity: TestIdentity,
  projectId: string,
  operationId: string,
  expectedDraftVersion: number,
  siteConfig: unknown,
): request.Test {
  return request(app.getHttpServer())
    .put(`/v1/workspaces/${identity.workspaceId}/projects/${projectId}/draft`)
    .set(authorize(identity))
    .set('Origin', allowedOrigin)
    .set('Idempotency-Key', operationId)
    .send({ expectedDraftVersion, siteConfig });
}

function projectId(response: request.Response): string {
  const value = responseBody(response)['id'];
  if (typeof value !== 'string') throw new Error('Expected project id');
  return value;
}

function rotatedConfig(
  activeVersion: number,
  versions: readonly number[],
): AppConfig {
  const base = loadAppConfig();
  return {
    ...base,
    idempotencyHmacActiveKeyVersion: activeVersion,
    idempotencyHmacKeyring: new Map(
      versions.map((version) => [version, Buffer.alloc(32, version)]),
    ),
  };
}

describe('authenticated sites drafts HTTP contract', () => {
  let app: INestApplication<App>;
  let pool: Pool;
  let owner: TestIdentity;
  let otherOwner: TestIdentity;
  const capturedLogs: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
    app = await createApplication(capturedLogs);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    capturedLogs.length = 0;
    owner = await seedIdentity(pool, 'owner');
    otherOwner = await seedIdentity(pool, 'other-owner');
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('requires authentication and a bounded idempotency key before a create transaction', async () => {
    const siteConfig = fixture('v4-minimal-valid.json');
    await request(app.getHttpServer())
      .post(`/v1/workspaces/${owner.workspaceId}/projects`)
      .send({ name: 'Unauthenticated', siteConfig })
      .expect(401);

    const missingKey = await request(app.getHttpServer())
      .post(`/v1/workspaces/${owner.workspaceId}/projects`)
      .set(authorize(owner))
      .set('Origin', allowedOrigin)
      .send({ name: 'Missing key', siteConfig })
      .expect(400);
    expect(errorCode(missingKey)).toBe('VALIDATION_ERROR');

    const longKey = await createProjectRequest(
      app,
      owner,
      'x'.repeat(129),
      siteConfig,
    ).expect(400);
    expect(errorCode(longKey)).toBe('VALIDATION_ERROR');
    await expect(siteCounts(pool)).resolves.toEqual({
      projects: 0,
      revisions: 0,
      idempotencyRecords: 0,
    });
  });

  it('creates one canonical v4 draft, initial revision, stable public identity, and PII-free replay record', async () => {
    const source = fixture('v4-bundled-dot-images-valid.json');
    const response = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      source,
      'Canonical project',
    ).expect(201);
    const body = responseBody(response);
    expect(body).toMatchObject({
      workspaceId: owner.workspaceId,
      name: 'Canonical project',
      draftVersion: 1,
      draftSchemaVersion: 4,
    });
    expect(body['id']).toEqual(expect.any(String));
    expect(body['publicSlug']).toEqual(expect.any(String));
    expect(body['publicUrl']).toMatch(
      /^http:\/\/localhost:4200\/p\/[A-Za-z0-9%._~-]+$/u,
    );

    const stored = await pool.query<{
      draft: unknown;
      revision: unknown;
    }>(
      `SELECT project."draft", revision."siteConfig" AS revision
         FROM "Project" AS project
         JOIN "ProjectRevision" AS revision
           ON revision."projectId" = project."id"
        WHERE project."id" = $1`,
      [body['id']],
    );
    expect(stored.rows).toHaveLength(1);
    const storedJson = JSON.stringify(stored.rows[0]);
    expect(storedJson).toContain('images/landing/office-studio.webp');
    expect(storedJson).not.toContain('./images/');

    const replay = await pool.query<StoredIdempotencySnapshot>(
      `SELECT "requestFingerprint", "responseBody"::text AS "responseBody"
         FROM "IdempotencyRecord"`,
    );
    expect(replay.rows).toHaveLength(1);
    expect(replay.rows[0]?.requestFingerprint).toMatch(
      /^hmac-sha256:v1:[0-9a-f]{64}$/u,
    );
    expect(replay.rows[0]?.responseBody).not.toContain('siteConfig');
    expect(replay.rows[0]?.responseBody).not.toContain('hello@nexus.app');
    expect(capturedLogs.join('\n')).not.toContain('hello@nexus.app');
  });

  it.each([
    'v4-data-url-rejected.json',
    'v4-bundled-traversal-rejected.json',
    'v4-pages-over-limit.json',
    'v4-document-over-limit.json',
    'legacy-v3-import.json',
    'future-version-rejected.json',
  ])('rejects %s before any site or idempotency write', async (fixtureName) => {
    const response = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture(fixtureName),
    ).expect(400);
    expect(errorCode(response)).toBe('VALIDATION_ERROR');
    await expect(siteCounts(pool)).resolves.toEqual({
      projects: 0,
      revisions: 0,
      idempotencyRecords: 0,
    });
  });

  it('replays the original create after response loss for RFC 8785-equivalent JSON', async () => {
    const operationId = randomUUID();
    const source = fixture('v4-minimal-valid.json');
    const first = await createProjectRequest(
      app,
      owner,
      operationId,
      source,
    ).expect(201);
    const retried = await createProjectRequest(
      app,
      owner,
      operationId,
      reorderJson(source),
    ).expect(201);

    expect(responseBody(retried)).toEqual(responseBody(first));
    await expect(siteCounts(pool)).resolves.toEqual({
      projects: 1,
      revisions: 1,
      idempotencyRecords: 1,
    });
  });

  it('rejects a create key reused with changed semantic payload', async () => {
    const operationId = randomUUID();
    const source = fixture('v4-minimal-valid.json');
    await createProjectRequest(app, owner, operationId, source).expect(201);
    const reused = await createProjectRequest(
      app,
      owner,
      operationId,
      source,
      'Changed name',
    ).expect(409);

    expect(errorCode(reused)).toBe('IDEMPOTENCY_KEY_REUSED');
    await expect(siteCounts(pool)).resolves.toEqual({
      projects: 1,
      revisions: 1,
      idempotencyRecords: 1,
    });
  });

  it('scopes the same key independently by workspace, project, and operation', async () => {
    const operationId = randomUUID();
    const source = fixture('v4-minimal-valid.json');
    const ownProject = await createProjectRequest(
      app,
      owner,
      operationId,
      source,
    ).expect(201);
    await createProjectRequest(app, otherOwner, operationId, source).expect(
      201,
    );
    await saveDraftRequest(
      app,
      owner,
      projectId(ownProject),
      operationId,
      1,
      fixture('v4-full-valid.json'),
    ).expect(200);

    await expect(siteCounts(pool)).resolves.toEqual({
      projects: 2,
      revisions: 3,
      idempotencyRecords: 3,
    });
  });

  it('returns a stable editor project and hides it across workspace boundaries', async () => {
    const created = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    ).expect(201);
    const id = projectId(created);

    const ownRead = await request(app.getHttpServer())
      .get(`/v1/workspaces/${owner.workspaceId}/projects/${id}`)
      .set(authorize(owner))
      .expect(200);
    expect(responseBody(ownRead)).toEqual(responseBody(created));

    const foreignRead = await request(app.getHttpServer())
      .get(`/v1/workspaces/${otherOwner.workspaceId}/projects/${id}`)
      .set(authorize(otherOwner))
      .expect(404);
    expect(errorCode(foreignRead)).toBe('NOT_FOUND');
  });

  it('saves a bounded draft at the expected version and preserves immutable revisions', async () => {
    const created = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    ).expect(201);
    const id = projectId(created);
    const saved = await saveDraftRequest(
      app,
      owner,
      id,
      randomUUID(),
      1,
      fixture('v4-bundled-dot-images-valid.json'),
    ).expect(200);

    expect(responseBody(saved)).toMatchObject({
      id,
      workspaceId: owner.workspaceId,
      publicSlug: responseBody(created)['publicSlug'],
      publicUrl: responseBody(created)['publicUrl'],
      draftVersion: 2,
      draftSchemaVersion: 4,
    });
    const revisions = await pool.query<{
      siteConfig: unknown;
      version: number;
    }>(
      `SELECT "version", "siteConfig"
         FROM "ProjectRevision"
        WHERE "projectId" = $1
        ORDER BY "version"`,
      [id],
    );
    expect(revisions.rows.map(({ version }) => version)).toEqual([1, 2]);
    expect(revisions.rows[0]?.siteConfig).toEqual(
      fixture('v4-minimal-valid.json'),
    );
    expect(JSON.stringify(revisions.rows[1]?.siteConfig)).not.toContain(
      './images/',
    );
  });

  it('rejects an invalid save before changing the draft or persisting replay state', async () => {
    const created = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    ).expect(201);
    const rejected = await saveDraftRequest(
      app,
      owner,
      projectId(created),
      randomUUID(),
      1,
      fixture('v4-data-url-rejected.json'),
    ).expect(400);
    expect(errorCode(rejected)).toBe('VALIDATION_ERROR');
    await expect(siteCounts(pool)).resolves.toEqual({
      projects: 1,
      revisions: 1,
      idempotencyRecords: 1,
    });
  });

  it('serializes concurrent same-key saves and returns one stored result', async () => {
    const created = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    ).expect(201);
    const id = projectId(created);
    const operationId = randomUUID();
    const source = fixture('v4-bundled-images-valid.json');
    const [first, second] = await Promise.all([
      saveDraftRequest(app, owner, id, operationId, 1, source),
      saveDraftRequest(app, owner, id, operationId, 1, reorderJson(source)),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(responseBody(first)).toEqual(responseBody(second));
    await expect(siteCounts(pool)).resolves.toEqual({
      projects: 1,
      revisions: 2,
      idempotencyRecords: 2,
    });
  });

  it('rejects a save key reused with changed payload and creates no extra revision', async () => {
    const created = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    ).expect(201);
    const id = projectId(created);
    const operationId = randomUUID();
    await saveDraftRequest(
      app,
      owner,
      id,
      operationId,
      1,
      fixture('v4-bundled-images-valid.json'),
    ).expect(200);
    const reused = await saveDraftRequest(
      app,
      owner,
      id,
      operationId,
      1,
      fixture('v4-minimal-valid.json'),
    ).expect(409);

    expect(errorCode(reused)).toBe('IDEMPOTENCY_KEY_REUSED');
    await expect(siteCounts(pool)).resolves.toEqual({
      projects: 1,
      revisions: 2,
      idempotencyRecords: 2,
    });
  });

  it('records a new-key stale save as a replayable version conflict without a revision', async () => {
    const created = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    ).expect(201);
    const id = projectId(created);
    await saveDraftRequest(
      app,
      owner,
      id,
      randomUUID(),
      1,
      fixture('v4-bundled-images-valid.json'),
    ).expect(200);
    const staleKey = randomUUID();
    const stale = await saveDraftRequest(
      app,
      owner,
      id,
      staleKey,
      1,
      fixture('v4-full-valid.json'),
    ).expect(409);
    expect(errorCode(stale)).toBe('PROJECT_VERSION_CONFLICT');

    const replay = await saveDraftRequest(
      app,
      owner,
      id,
      staleKey,
      1,
      fixture('v4-full-valid.json'),
    ).expect(409);
    expect(responseBody(replay)['error']).toMatchObject({
      code: 'PROJECT_VERSION_CONFLICT',
    });
    await expect(siteCounts(pool)).resolves.toEqual({
      projects: 1,
      revisions: 2,
      idempotencyRecords: 3,
    });
  });

  it('allows one winner when different keys race at the same expected draft version', async () => {
    const created = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    ).expect(201);
    const id = projectId(created);
    const responses = await Promise.all([
      saveDraftRequest(
        app,
        owner,
        id,
        randomUUID(),
        1,
        fixture('v4-bundled-images-valid.json'),
      ),
      saveDraftRequest(
        app,
        owner,
        id,
        randomUUID(),
        1,
        fixture('v4-full-valid.json'),
      ),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const rejected = responses.find(({ status }) => status === 409);
    expect(rejected === undefined ? undefined : errorCode(rejected)).toBe(
      'PROJECT_VERSION_CONFLICT',
    );
    await expect(siteCounts(pool)).resolves.toEqual({
      projects: 1,
      revisions: 2,
      idempotencyRecords: 3,
    });
  });

  it('paginates project summaries and immutable revision metadata without draft JSON', async () => {
    const first = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
      'First',
    ).expect(201);
    const second = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
      'Second',
    ).expect(201);
    await saveDraftRequest(
      app,
      owner,
      projectId(second),
      randomUUID(),
      1,
      fixture('v4-full-valid.json'),
    ).expect(200);

    const summariesOne = await request(app.getHttpServer())
      .get(`/v1/workspaces/${owner.workspaceId}/projects?limit=1`)
      .set(authorize(owner))
      .expect(200);
    const summariesOneBody = responseBody(summariesOne);
    expect(summariesOneBody['items']).toHaveLength(1);
    expect(JSON.stringify(summariesOneBody['items'])).not.toContain('draft');
    const cursor = summariesOneBody['nextCursor'];
    expect(cursor).toEqual(expect.any(String));
    const summariesTwo = await request(app.getHttpServer())
      .get(
        `/v1/workspaces/${owner.workspaceId}/projects?limit=1&cursor=${encodeURIComponent(
          cursor as string,
        )}`,
      )
      .set(authorize(owner))
      .expect(200);
    const summaryIds = [summariesOne, summariesTwo].flatMap((response) => {
      const items = responseBody(response)['items'];
      return Array.isArray(items)
        ? items.map((item) => (isRecord(item) ? item['id'] : undefined))
        : [];
    });
    expect(new Set(summaryIds)).toEqual(
      new Set([projectId(first), projectId(second)]),
    );

    const revisions = await request(app.getHttpServer())
      .get(
        `/v1/workspaces/${owner.workspaceId}/projects/${projectId(
          second,
        )}/revisions?limit=1`,
      )
      .set(authorize(owner))
      .expect(200);
    const revisionItems = responseBody(revisions)['items'];
    expect(Array.isArray(revisionItems) ? revisionItems : []).toMatchObject([
      { version: 2, schemaVersion: 4 },
    ]);
    expect(JSON.stringify(revisionItems)).not.toContain('siteConfig');

    const invalidLimit = await request(app.getHttpServer())
      .get(`/v1/workspaces/${owner.workspaceId}/projects?limit=101`)
      .set(authorize(owner))
      .expect(400);
    expect(errorCode(invalidLimit)).toBe('VALIDATION_ERROR');

    const invalidSummaryCursor = await request(app.getHttpServer())
      .get(`/v1/workspaces/${owner.workspaceId}/projects?cursor=not-a-cursor`)
      .set(authorize(owner))
      .expect(400);
    expect(errorCode(invalidSummaryCursor)).toBe('VALIDATION_ERROR');

    const invalidRevisionCursor = await request(app.getHttpServer())
      .get(
        `/v1/workspaces/${owner.workspaceId}/projects/${projectId(
          second,
        )}/revisions?cursor=not-a-cursor`,
      )
      .set(authorize(owner))
      .expect(400);
    expect(errorCode(invalidRevisionCursor)).toBe('VALIDATION_ERROR');
  });

  it('replays records across HMAC key rotation and fails closed when the stored key version is unavailable', async () => {
    const operationId = randomUUID();
    const source = fixture('v4-minimal-valid.json');
    const firstApp = await createApplication([], rotatedConfig(1, [1, 2]));
    const first = await createProjectRequest(
      firstApp,
      owner,
      operationId,
      source,
    ).expect(201);
    await firstApp.close();

    const rotatedApp = await createApplication([], rotatedConfig(2, [1, 2]));
    const replay = await createProjectRequest(
      rotatedApp,
      owner,
      operationId,
      reorderJson(source),
    ).expect(201);
    expect(responseBody(replay)).toEqual(responseBody(first));
    await rotatedApp.close();

    const missingOldKeyApp = await createApplication([], rotatedConfig(2, [2]));
    const failedClosed = await createProjectRequest(
      missingOldKeyApp,
      owner,
      operationId,
      source,
    ).expect(500);
    expect(errorCode(failedClosed)).toBe('INTERNAL_SERVER_ERROR');
    await missingOldKeyApp.close();
    await expect(siteCounts(pool)).resolves.toEqual({
      projects: 1,
      revisions: 1,
      idempotencyRecords: 1,
    });
  });

  it('fails closed for unknown or malformed stored fingerprint versions', async () => {
    const operationId = randomUUID();
    const source = fixture('v4-minimal-valid.json');
    await createProjectRequest(app, owner, operationId, source).expect(201);

    for (const fingerprint of [
      `hmac-sha256:v99:${'a'.repeat(64)}`,
      'a'.repeat(64),
    ]) {
      await pool.query(
        `UPDATE "IdempotencyRecord"
            SET "requestFingerprint" = $1
          WHERE "key" = $2`,
        [fingerprint, operationId],
      );
      const replay = await createProjectRequest(
        app,
        owner,
        operationId,
        source,
      ).expect(500);
      expect(errorCode(replay)).toBe('INTERNAL_SERVER_ERROR');
    }
    await expect(siteCounts(pool)).resolves.toEqual({
      projects: 1,
      revisions: 1,
      idempotencyRecords: 1,
    });
  });

  it('rejects malformed client capabilities before a transaction', async () => {
    const response = await createProjectRequest(
      app,
      owner,
      randomUUID(),
      fixture('v4-minimal-valid.json'),
    )
      .set(
        'Nexus-Client-Capabilities',
        'site-config-read=4, 5;site-config-write=4,5',
      )
      .expect(400);
    expect(errorCode(response)).toBe('INVALID_CLIENT_CAPABILITIES');
    await expect(siteCounts(pool)).resolves.toEqual({
      projects: 0,
      revisions: 0,
      idempotencyRecords: 0,
    });
  });
});
