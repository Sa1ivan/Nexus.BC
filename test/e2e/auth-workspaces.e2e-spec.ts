import { createDecipheriv, createHmac, randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import {
  Controller,
  Get,
  Req,
  type INestApplication,
  type LoggerService,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request as ExpressRequest } from 'express';
import { Pool } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import {
  NOTIFICATION_ENQUEUE,
  type NotificationEnqueue,
} from '../../src/modules/notifications/application/public';
import {
  AUDIT_WRITER,
  type AuditWriter,
} from '../../src/shared/audit/audit-writer';
import { Public } from '../../src/shared/http/public.decorator';
import { requestClientIp } from '../../src/shared/http/request-contract';

const allowedOrigin = 'http://localhost:4200';
const password = 'correct horse battery staple';
const replacementPassword = 'replacement horse battery staple';
const outboxEncryptionKey = Buffer.alloc(32, 1);

interface ApplicationOptions {
  readonly audit?: AuditWriter;
  readonly logs?: string[];
  readonly notifications?: NotificationEnqueue;
}

interface AuthSession {
  readonly accessToken: string;
  readonly cookie: string;
  readonly userId: string;
}

interface StoredAuthOutbox {
  readonly aggregateId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly secretCiphertext: Buffer;
  readonly secretExpiresAt: Date;
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
    this.messages.push(formatLogValues([message, ...optionalParameters]));
  }
}

function formatLogValues(values: readonly unknown[]): string {
  return values
    .map((value) =>
      typeof value === 'string'
        ? value
        : inspect(value, {
            breakLength: Number.POSITIVE_INFINITY,
            colors: false,
            depth: null,
          }),
    )
    .join(' ');
}

@Public()
@Controller('__test/client-ip')
class ClientIpProbeController {
  @Get()
  read(@Req() request: ExpressRequest): { readonly ip: string } {
    return { ip: requestClientIp(request, 'production') };
  }
}

async function createApplication(
  options: ApplicationOptions = {},
): Promise<INestApplication<App>> {
  const builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: [ClientIpProbeController],
  });
  if (options.audit !== undefined) {
    builder.overrideProvider(AUDIT_WRITER).useValue(options.audit);
  }
  if (options.notifications !== undefined) {
    builder
      .overrideProvider(NOTIFICATION_ENQUEUE)
      .useValue(options.notifications);
  }
  const moduleFixture = await builder.compile();
  const app = moduleFixture.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  app.useLogger(new CapturingLogger(options.logs ?? []));
  await app.init();
  return app;
}

async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM "Outbox"');
  await pool.query('DELETE FROM "Membership"');
  await pool.query('DELETE FROM "Workspace"');
  await pool.query('DELETE FROM "User"');
  await pool.query('ALTER TABLE "AuditEvent" DISABLE TRIGGER USER');
  await pool.query('ALTER TABLE "AuditSequence" DISABLE TRIGGER USER');
  try {
    await pool.query('TRUNCATE TABLE "AuditEvent", "AuditSequence"');
    await pool.query(
      'INSERT INTO "AuditSequence" ("id", "nextValue") VALUES (1, 1)',
    );
  } finally {
    await pool.query('ALTER TABLE "AuditEvent" ENABLE TRIGGER USER');
    await pool.query('ALTER TABLE "AuditSequence" ENABLE TRIGGER USER');
  }
}

function errorCode(response: request.Response): unknown {
  const body: unknown = response.body;
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return undefined;
  }
  const error = body.error;
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

function requireSetCookieHeader(response: request.Response): string {
  const setCookie: unknown = response.headers['set-cookie'];
  const cookieHeader: unknown = Array.isArray(setCookie)
    ? (setCookie as readonly unknown[])[0]
    : setCookie;
  if (typeof cookieHeader !== 'string') {
    throw new Error('Expected a Set-Cookie response header');
  }
  return cookieHeader;
}

function responseCookie(response: request.Response): string {
  const cookieHeader = requireSetCookieHeader(response);
  const cookie = cookieHeader.split(';')[0];
  if (cookie === undefined || cookie.length === 0) {
    throw new Error('Expected a refresh cookie value');
  }
  return cookie;
}

function setCookieHeader(response: request.Response): string {
  return requireSetCookieHeader(response);
}

function accessToken(response: request.Response): string {
  const body: unknown = response.body;
  if (
    typeof body !== 'object' ||
    body === null ||
    !('accessToken' in body) ||
    typeof body.accessToken !== 'string'
  ) {
    throw new Error('Expected an access token response');
  }
  return body.accessToken;
}

function tokenRecordId(payload: unknown): string {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('tokenRecordId' in payload) ||
    typeof payload.tokenRecordId !== 'string'
  ) {
    throw new Error('Expected an identifier-only auth Outbox payload');
  }
  return payload.tokenRecordId;
}

function decryptAuthSecret(ciphertext: Buffer): string {
  if (ciphertext[0] !== 1 || ciphertext.byteLength <= 29) {
    throw new Error('Unexpected auth secret ciphertext envelope');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    outboxEncryptionKey,
    ciphertext.subarray(1, 13),
  );
  decipher.setAuthTag(ciphertext.subarray(13, 29));
  return Buffer.concat([
    decipher.update(ciphertext.subarray(29)),
    decipher.final(),
  ]).toString('utf8');
}

async function latestAuthOutbox(
  pool: Pool,
  userId: string,
  kind: 'AUTH_EMAIL_VERIFICATION' | 'AUTH_PASSWORD_RESET',
): Promise<StoredAuthOutbox> {
  const result = await pool.query<StoredAuthOutbox>(
    `SELECT "aggregateId", "kind", "payload", "secretCiphertext", "secretExpiresAt"
       FROM "Outbox"
      WHERE "aggregateId" = $1 AND "kind" = $2
      ORDER BY "createdAt" DESC
      LIMIT 1`,
    [userId, kind],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`Expected ${kind} Outbox row for ${userId}`);
  }
  return row;
}

async function register(
  app: INestApplication<App>,
  pool: Pool,
  email: string,
  userPassword = password,
): Promise<{ readonly token: string; readonly userId: string }> {
  const response = await request(app.getHttpServer())
    .post('/v1/auth/register')
    .send({ email, password: userPassword })
    .expect(201);
  const body: unknown = response.body;
  if (
    typeof body !== 'object' ||
    body === null ||
    !('userId' in body) ||
    typeof body.userId !== 'string'
  ) {
    throw new Error('Expected a registration userId');
  }
  const outbox = await latestAuthOutbox(
    pool,
    body.userId,
    'AUTH_EMAIL_VERIFICATION',
  );
  return {
    userId: body.userId,
    token: decryptAuthSecret(outbox.secretCiphertext),
  };
}

async function verify(
  app: INestApplication<App>,
  token: string,
): Promise<void> {
  await request(app.getHttpServer())
    .post('/v1/auth/verify-email')
    .send({ token })
    .expect(204);
}

async function login(
  app: INestApplication<App>,
  email: string,
  userPassword = password,
): Promise<{ readonly accessToken: string; readonly cookie: string }> {
  const response = await request(app.getHttpServer())
    .post('/v1/auth/login')
    .set('Origin', allowedOrigin)
    .send({ email, password: userPassword })
    .expect(200);
  return {
    accessToken: accessToken(response),
    cookie: responseCookie(response),
  };
}

async function createVerifiedSession(
  app: INestApplication<App>,
  pool: Pool,
  email: string,
): Promise<AuthSession> {
  const registration = await register(app, pool, email);
  await verify(app, registration.token);
  const session = await login(app, email);
  return { ...session, userId: registration.userId };
}

async function requestPasswordResetToken(
  app: INestApplication<App>,
  pool: Pool,
  email: string,
  userId: string,
): Promise<string> {
  await request(app.getHttpServer())
    .post('/v1/auth/password-reset/request')
    .send({ email })
    .expect(202);
  const outbox = await latestAuthOutbox(pool, userId, 'AUTH_PASSWORD_RESET');
  return decryptAuthSecret(outbox.secretCiphertext);
}

async function waitForBlockedDatabaseQuery(
  pool: Pool,
  waitEvent: 'advisory' | 'transactionid',
  tableName?: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event = $1
          AND ($2::text IS NULL OR query LIKE '%' || $2 || '%')`,
      [waitEvent, tableName ?? null],
    );
    if (result.rows[0]?.count !== '0') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Timed out waiting for a database query blocked on ${waitEvent}`,
  );
}

function authorize(access: string): { readonly Authorization: string } {
  return { Authorization: `Bearer ${access}` };
}

function signTestAccessToken(
  payload: Readonly<Record<string, unknown>>,
): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    'utf8',
  ).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  const unsigned = `${header}.${encodedPayload}`;
  const signature = createHmac('sha256', 'test-access-token-secret-32-bytes')
    .update(unsigned, 'utf8')
    .digest('base64url');
  return `${unsigned}.${signature}`;
}

describe('auth lifecycle and workspace tenancy', () => {
  let app: INestApplication<App>;
  let pool: Pool;
  let capturedLogs: string[];

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    capturedLogs = [];
    app = await createApplication({ logs: capturedLogs });
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('registers canonically and stores token plus encrypted Outbox atomically without logging secrets', async () => {
    const rawEmail = '  Owner@Example.Test  ';
    const canonicalEmail = 'owner@example.test';
    const registration = await register(app, pool, rawEmail);
    const user = await pool.query<{
      email: string;
      emailVerifiedAt: Date | null;
      passwordHash: string;
    }>(
      `SELECT "email", "emailVerifiedAt", "passwordHash"
           FROM "User"
          WHERE "id" = $1`,
      [registration.userId],
    );
    expect(user.rows).toHaveLength(1);
    expect(user.rows[0]).toMatchObject({
      email: canonicalEmail,
      emailVerifiedAt: null,
    });
    const passwordHash = user.rows[0]?.passwordHash;
    expect(passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$/u);
    expect(passwordHash).not.toContain(password);
    const encodedHash = passwordHash?.split('$')[5];
    expect(encodedHash).toBeDefined();
    expect(Buffer.from(encodedHash ?? '', 'base64').byteLength).toBe(32);

    const outbox = await latestAuthOutbox(
      pool,
      registration.userId,
      'AUTH_EMAIL_VERIFICATION',
    );
    const recordId = tokenRecordId(outbox.payload);
    const token = await pool.query<{
      expiresAt: Date;
      tokenHash: string;
    }>(
      `SELECT "expiresAt", "tokenHash"
           FROM "EmailVerificationToken"
          WHERE "id" = $1`,
      [recordId],
    );
    expect(token.rows).toHaveLength(1);
    expect(token.rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(token.rows[0]?.tokenHash).not.toBe(registration.token);
    expect(outbox.secretExpiresAt).toEqual(token.rows[0]?.expiresAt);
    expect(outbox.payload).toEqual({ tokenRecordId: recordId });
    expect(outbox.secretCiphertext.includes(registration.token)).toBe(false);
    expect(decryptAuthSecret(outbox.secretCiphertext)).toBe(registration.token);

    const duplicate = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: canonicalEmail.toUpperCase(), password })
      .expect(409);
    expect(errorCode(duplicate)).toBe('EMAIL_ALREADY_REGISTERED');
    await expect(
      pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM "User"'),
    ).resolves.toMatchObject({ rows: [{ count: '1' }] });
    await expect(
      pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM "Outbox"'),
    ).resolves.toMatchObject({ rows: [{ count: '1' }] });

    const logText = capturedLogs.join('\n');
    expect(logText).not.toContain(registration.token);
    expect(logText).not.toContain(password);
    expect(logText).not.toContain(canonicalEmail);
  });

  it('rolls registration back when the transactional Outbox write fails', async () => {
    const failedEmail = 'rollback@example.test';
    const failingLogs: string[] = [];
    let failedSecret: string | undefined;
    const failingNotifications: NotificationEnqueue = {
      enqueue: (_context, notification) => {
        failedSecret = decryptAuthSecret(
          Buffer.from(notification.secretCiphertext),
        );
        return Promise.reject(
          new Error(
            `outbox unavailable: ${failedEmail} ${password} ${failedSecret}`,
          ),
        );
      },
    };
    const failingApp = await createApplication({
      logs: failingLogs,
      notifications: failingNotifications,
    });
    try {
      await request(failingApp.getHttpServer())
        .post('/v1/auth/register')
        .send({ email: failedEmail, password })
        .expect(500);
      for (const tableName of ['User', 'EmailVerificationToken', 'Outbox']) {
        const result = await pool.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM "${tableName}"`,
        );
        expect(result.rows).toEqual([{ count: '0' }]);
      }
      expect(failedSecret).toBeDefined();
      const errorLogText = failingLogs.join('\n');
      expect(errorLogText).toContain('api_request_failed');
      expect(errorLogText).toContain('INTERNAL_SERVER_ERROR');
      expect(errorLogText).toContain('requestId');
      expect(errorLogText).not.toContain(failedSecret);
      expect(errorLogText).not.toContain(password);
      expect(errorLogText).not.toContain(failedEmail);
    } finally {
      await failingApp.close();
    }
  });

  it('enforces verification, Origin, secure cookie, JWT lifetime, and the opt-out guard', async () => {
    const email = 'lifecycle@example.test';
    const registration = await register(app, pool, email);

    const beforeVerification = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('Origin', allowedOrigin)
      .send({ email, password })
      .expect(403);
    expect(errorCode(beforeVerification)).toBe('EMAIL_NOT_VERIFIED');

    await verify(app, registration.token);
    const reusedVerification = await request(app.getHttpServer())
      .post('/v1/auth/verify-email')
      .send({ token: registration.token })
      .expect(400);
    expect(errorCode(reusedVerification)).toBe('VERIFICATION_TOKEN_INVALID');

    const missingOrigin = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email, password })
      .expect(403);
    expect(errorCode(missingOrigin)).toBe('ORIGIN_REQUIRED');
    const wrongOrigin = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('Origin', 'https://attacker.example')
      .send({ email, password })
      .expect(403);
    expect(errorCode(wrongOrigin)).toBe('CORS_ORIGIN_DENIED');

    const response = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('Origin', allowedOrigin)
      .send({ email, password })
      .expect(200);
    expect(response.body).toMatchObject({
      expiresInSeconds: 600,
      tokenType: 'Bearer',
    });
    const cookieHeader = setCookieHeader(response);
    expect(cookieHeader).toContain('Path=/v1/auth');
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('Secure');
    expect(cookieHeader).toContain('SameSite=Lax');
    expect(cookieHeader).toContain('Max-Age=2592000');

    const jwt = accessToken(response);
    const payloadSegment = jwt.split('.')[1];
    if (payloadSegment === undefined) {
      throw new Error('Expected a JWT payload');
    }
    const claims: unknown = JSON.parse(
      Buffer.from(payloadSegment, 'base64url').toString('utf8'),
    );
    expect(claims).toMatchObject({
      sub: registration.userId,
      email,
    });
    if (
      typeof claims !== 'object' ||
      claims === null ||
      !('iat' in claims) ||
      !('exp' in claims) ||
      typeof claims.iat !== 'number' ||
      typeof claims.exp !== 'number'
    ) {
      throw new Error('Expected numeric JWT timestamps');
    }
    expect(claims.exp - claims.iat).toBe(600);

    const jwtSegments = jwt.split('.');
    const jwtSignature = jwtSegments[2];
    if (jwtSegments.length !== 3 || jwtSignature === undefined) {
      throw new Error('Expected a signed JWT');
    }
    const tamperedSignature = `${jwtSignature.startsWith('A') ? 'B' : 'A'}${jwtSignature.slice(1)}`;
    const tamperedToken = `${jwtSegments[0]}.${jwtSegments[1]}.${tamperedSignature}`;
    const tampered = await request(app.getHttpServer())
      .get(`/v1/workspaces/${randomUUID()}`)
      .set('Authorization', `Bearer ${tamperedToken}`)
      .expect(401);
    expect(errorCode(tampered)).toBe('AUTHENTICATION_REQUIRED');

    const freshIssuedAt = Math.floor(Date.now() / 1000);
    const freshToken = signTestAccessToken({
      sub: registration.userId,
      email,
      iat: freshIssuedAt,
      exp: freshIssuedAt + 60,
    });
    const fresh = await request(app.getHttpServer())
      .get(`/v1/workspaces/${randomUUID()}`)
      .set('Authorization', `Bearer ${freshToken}`)
      .expect(404);
    expect(errorCode(fresh)).toBe('NOT_FOUND');

    const expiredIssuedAt = Math.floor(Date.now() / 1000) - 120;
    const expiredToken = signTestAccessToken({
      sub: registration.userId,
      email,
      iat: expiredIssuedAt,
      exp: expiredIssuedAt + 60,
    });
    const expired = await request(app.getHttpServer())
      .get(`/v1/workspaces/${randomUUID()}`)
      .set('Authorization', `Bearer ${expiredToken}`)
      .expect(401);
    expect(errorCode(expired)).toBe('AUTHENTICATION_REQUIRED');

    const unauthenticated = await request(app.getHttpServer())
      .get(`/v1/workspaces/${randomUUID()}`)
      .expect(401);
    expect(errorCode(unauthenticated)).toBe('AUTHENTICATION_REQUIRED');
    const invalidToken = await request(app.getHttpServer())
      .get(`/v1/workspaces/${randomUUID()}`)
      .set('Authorization', 'Bearer invalid')
      .expect(401);
    expect(errorCode(invalidToken)).toBe('AUTHENTICATION_REQUIRED');
  });

  it('rejects expired verification, reset, and refresh credentials', async () => {
    const verification = await register(
      app,
      pool,
      'expired-verification@example.test',
    );
    await pool.query(
      `UPDATE "EmailVerificationToken"
          SET "expiresAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 minute'
        WHERE "userId" = $1`,
      [verification.userId],
    );
    const expiredVerification = await request(app.getHttpServer())
      .post('/v1/auth/verify-email')
      .send({ token: verification.token })
      .expect(400);
    expect(errorCode(expiredVerification)).toBe('VERIFICATION_TOKEN_INVALID');

    const session = await createVerifiedSession(
      app,
      pool,
      'expired-session@example.test',
    );
    await pool.query(
      `UPDATE "RefreshSession"
          SET "expiresAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 minute'
        WHERE "userId" = $1`,
      [session.userId],
    );
    const expiredRefresh = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .set('Origin', allowedOrigin)
      .set('Cookie', session.cookie)
      .send({})
      .expect(401);
    expect(errorCode(expiredRefresh)).toBe('SESSION_INVALID');

    await request(app.getHttpServer())
      .post('/v1/auth/password-reset/request')
      .send({ email: 'expired-session@example.test' })
      .expect(202);
    const resetOutbox = await latestAuthOutbox(
      pool,
      session.userId,
      'AUTH_PASSWORD_RESET',
    );
    const resetToken = decryptAuthSecret(resetOutbox.secretCiphertext);
    await pool.query(
      `UPDATE "PasswordResetToken"
          SET "expiresAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '1 minute'
        WHERE "userId" = $1`,
      [session.userId],
    );
    const expiredReset = await request(app.getHttpServer())
      .post('/v1/auth/password-reset/confirm')
      .send({ token: resetToken, password: replacementPassword })
      .expect(400);
    expect(errorCode(expiredReset)).toBe('RESET_TOKEN_INVALID');
  });

  it('rate limits repeated public token attempts', async () => {
    const invalidToken = 'x'.repeat(32);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const invalid = await request(app.getHttpServer())
        .post('/v1/auth/verify-email')
        .send({ token: invalidToken })
        .expect(400);
      expect(errorCode(invalid)).toBe('VERIFICATION_TOKEN_INVALID');
    }

    const limited = await request(app.getHttpServer())
      .post('/v1/auth/verify-email')
      .send({ token: invalidToken })
      .expect(429);
    expect(errorCode(limited)).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBe('60');
  });

  it('uses the documented Railway client IP header and ignores spoofed XFF', async () => {
    await request(app.getHttpServer())
      .get('/__test/client-ip')
      .set('X-Real-IP', '198.51.100.10')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Railway-Edge', 'ams1')
      .set('X-Railway-Request-Id', 'railway-request-123')
      .set('X-Request-Start', '1785974400000')
      .expect(200)
      .expect({ ip: '198.51.100.10' });

    await request(app.getHttpServer())
      .get('/__test/client-ip')
      .set('X-Real-IP', '198.51.100.10')
      .set('X-Forwarded-For', '203.0.113.99')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Railway-Edge', 'ams1')
      .set('X-Railway-Request-Id', 'railway-request-456')
      .set('X-Request-Start', '1785974400000')
      .expect(200)
      .expect({ ip: '198.51.100.10' });

    const untrusted = await request(app.getHttpServer())
      .get('/__test/client-ip')
      .set('X-Real-IP', '203.0.113.99')
      .expect(200);
    expect(untrusted.body).not.toEqual({ ip: '203.0.113.99' });
  });

  it('rotates refresh tokens, revokes reused families, handles concurrent reuse, and logs out', async () => {
    const email = 'refresh@example.test';
    const session = await createVerifiedSession(app, pool, email);

    await request(app.getHttpServer())
      .get('/v1/auth/refresh')
      .set('Cookie', session.cookie)
      .expect(404);
    const missingOrigin = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .set('Cookie', session.cookie)
      .send({})
      .expect(403);
    expect(errorCode(missingOrigin)).toBe('ORIGIN_REQUIRED');

    const rotated = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .set('Origin', allowedOrigin)
      .set('Cookie', session.cookie)
      .send({})
      .expect(200);
    const replacementCookie = responseCookie(rotated);
    expect(replacementCookie).not.toBe(session.cookie);

    const reuse = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .set('Origin', allowedOrigin)
      .set('Cookie', session.cookie)
      .send({})
      .expect(401);
    expect(errorCode(reuse)).toBe('SESSION_INVALID');
    await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .set('Origin', allowedOrigin)
      .set('Cookie', replacementCookie)
      .send({})
      .expect(401);

    const concurrentSession = await login(app, email);
    const concurrentResponses = await Promise.all([
      request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('Origin', allowedOrigin)
        .set('Cookie', concurrentSession.cookie)
        .send({}),
      request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('Origin', allowedOrigin)
        .set('Cookie', concurrentSession.cookie)
        .send({}),
    ]);
    expect(concurrentResponses.map(({ status }) => status).sort()).toEqual([
      200, 401,
    ]);
    const winningResponse = concurrentResponses.find(
      ({ status }) => status === 200,
    );
    if (winningResponse === undefined) {
      throw new Error('Expected one successful concurrent refresh');
    }
    await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .set('Origin', allowedOrigin)
      .set('Cookie', responseCookie(winningResponse))
      .send({})
      .expect(401);

    const logoutSession = await login(app, email);
    await request(app.getHttpServer())
      .get('/v1/auth/logout')
      .set('Cookie', logoutSession.cookie)
      .expect(404);
    const logout = await request(app.getHttpServer())
      .post('/v1/auth/logout')
      .set('Origin', allowedOrigin)
      .set('Cookie', logoutSession.cookie)
      .send({})
      .expect(204);
    expect(setCookieHeader(logout)).toContain('Max-Age=0');
    await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .set('Origin', allowedOrigin)
      .set('Cookie', logoutSession.cookie)
      .send({})
      .expect(401);
  });

  it('keeps reset requests non-enumerating, consumes reset once, and revokes sessions', async () => {
    const email = 'reset@example.test';
    const session = await createVerifiedSession(app, pool, email);

    const missingStartedAt = performance.now();
    const missing = await request(app.getHttpServer())
      .post('/v1/auth/password-reset/request')
      .send({ email: 'missing@example.test' })
      .expect(202);
    const missingDuration = performance.now() - missingStartedAt;
    const existingStartedAt = performance.now();
    const existing = await request(app.getHttpServer())
      .post('/v1/auth/password-reset/request')
      .send({ email })
      .expect(202);
    const existingDuration = performance.now() - existingStartedAt;
    expect(missing.body).toEqual({ accepted: true });
    expect(existing.body).toEqual(missing.body);
    expect(missingDuration).toBeGreaterThanOrEqual(300);
    expect(existingDuration).toBeGreaterThanOrEqual(300);

    const outbox = await latestAuthOutbox(
      pool,
      session.userId,
      'AUTH_PASSWORD_RESET',
    );
    const resetToken = decryptAuthSecret(outbox.secretCiphertext);
    await request(app.getHttpServer())
      .post('/v1/auth/password-reset/confirm')
      .send({ token: resetToken, password: replacementPassword })
      .expect(204);
    const reusedReset = await request(app.getHttpServer())
      .post('/v1/auth/password-reset/confirm')
      .send({ token: resetToken, password: replacementPassword })
      .expect(400);
    expect(errorCode(reusedReset)).toBe('RESET_TOKEN_INVALID');

    await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .set('Origin', allowedOrigin)
      .set('Cookie', session.cookie)
      .send({})
      .expect(401);
    const oldPassword = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .set('Origin', allowedOrigin)
      .send({ email, password })
      .expect(401);
    expect(errorCode(oldPassword)).toBe('INVALID_CREDENTIALS');
    await login(app, email, replacementPassword);

    const resetRows = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM "PasswordResetToken"',
    );
    const resetOutboxRows = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM "Outbox"
        WHERE "kind" = 'AUTH_PASSWORD_RESET'`,
    );
    expect(resetRows.rows).toEqual([{ count: '1' }]);
    expect(resetOutboxRows.rows).toEqual([{ count: '1' }]);
  });

  it('invalidates every outstanding password-reset token after one succeeds', async () => {
    const email = 'reset-all@example.test';
    const session = await createVerifiedSession(app, pool, email);
    const firstToken = await requestPasswordResetToken(
      app,
      pool,
      email,
      session.userId,
    );
    const secondToken = await requestPasswordResetToken(
      app,
      pool,
      email,
      session.userId,
    );
    expect(secondToken).not.toBe(firstToken);

    await request(app.getHttpServer())
      .post('/v1/auth/password-reset/confirm')
      .send({ token: secondToken, password: replacementPassword })
      .expect(204);
    const staleReset = await request(app.getHttpServer())
      .post('/v1/auth/password-reset/confirm')
      .send({ token: firstToken, password })
      .expect(400);
    expect(errorCode(staleReset)).toBe('RESET_TOKEN_INVALID');
  });

  it('serializes concurrent password resets for different active tokens', async () => {
    const email = 'reset-concurrent@example.test';
    const session = await createVerifiedSession(app, pool, email);
    const firstToken = await requestPasswordResetToken(
      app,
      pool,
      email,
      session.userId,
    );
    const secondToken = await requestPasswordResetToken(
      app,
      pool,
      email,
      session.userId,
    );

    const responses = await Promise.all([
      request(app.getHttpServer())
        .post('/v1/auth/password-reset/confirm')
        .send({ token: firstToken, password: replacementPassword }),
      request(app.getHttpServer())
        .post('/v1/auth/password-reset/confirm')
        .send({ token: secondToken, password }),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([204, 400]);
    const rejected = responses.find(({ status }) => status === 400);
    expect(rejected === undefined ? undefined : errorCode(rejected)).toBe(
      'RESET_TOKEN_INVALID',
    );
  });

  it('does not leave a replacement refresh session active across password reset', async () => {
    const email = 'reset-refresh-race@example.test';
    const session = await createVerifiedSession(app, pool, email);
    const resetToken = await requestPasswordResetToken(
      app,
      pool,
      email,
      session.userId,
    );
    const advisoryLockKey = 2_026_080_601;
    const blocker = await pool.connect();
    await blocker.query('SELECT pg_advisory_lock($1)', [advisoryLockKey]);
    await pool.query(
      `CREATE FUNCTION test_block_refresh_rotation() RETURNS trigger AS $body$
       BEGIN
         IF NEW."rotatedAt" IS NOT NULL AND OLD."rotatedAt" IS NULL THEN
           PERFORM pg_advisory_xact_lock(${advisoryLockKey});
         END IF;
         RETURN NEW;
       END;
       $body$ LANGUAGE plpgsql`,
    );
    await pool.query(
      `CREATE TRIGGER test_block_refresh_rotation
         BEFORE UPDATE ON "RefreshSession"
         FOR EACH ROW EXECUTE FUNCTION test_block_refresh_rotation()`,
    );

    try {
      const refreshPromise = request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('Origin', allowedOrigin)
        .set('Cookie', session.cookie)
        .send({})
        .then((response) => response);
      await waitForBlockedDatabaseQuery(pool, 'advisory', 'RefreshSession');

      const resetPromise = request(app.getHttpServer())
        .post('/v1/auth/password-reset/confirm')
        .send({ token: resetToken, password: replacementPassword })
        .then((response) => response);
      await waitForBlockedDatabaseQuery(pool, 'transactionid');

      await blocker.query('SELECT pg_advisory_unlock($1)', [advisoryLockKey]);
      const [refreshResponse, resetResponse] = await Promise.all([
        refreshPromise,
        resetPromise,
      ]);
      expect(refreshResponse.status).toBe(200);
      expect(resetResponse.status).toBe(204);

      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .set('Origin', allowedOrigin)
        .set('Cookie', responseCookie(refreshResponse))
        .send({})
        .expect(401);
    } finally {
      await blocker.query('SELECT pg_advisory_unlock($1)', [advisoryLockKey]);
      blocker.release();
      await pool.query(
        'DROP TRIGGER IF EXISTS test_block_refresh_rotation ON "RefreshSession"',
      );
      await pool.query('DROP FUNCTION IF EXISTS test_block_refresh_rotation()');
    }
  });

  it('enforces tenant hiding, owner/editor roles, last-owner protection, and atomic audit', async () => {
    const owner = await createVerifiedSession(app, pool, 'owner@example.test');
    const editor = await createVerifiedSession(
      app,
      pool,
      'editor@example.test',
    );
    const outsider = await createVerifiedSession(
      app,
      pool,
      'outsider@example.test',
    );

    const workspaceResponse = await request(app.getHttpServer())
      .post('/v1/workspaces')
      .set(authorize(owner.accessToken))
      .send({ name: 'Owner workspace' })
      .expect(201);
    const workspaceBody: unknown = workspaceResponse.body;
    if (
      typeof workspaceBody !== 'object' ||
      workspaceBody === null ||
      !('id' in workspaceBody) ||
      typeof workspaceBody.id !== 'string'
    ) {
      throw new Error('Expected a workspace id');
    }
    const workspaceId = workspaceBody.id;
    await pool.query(
      `INSERT INTO "Membership"
         ("workspaceId", "userId", "role", "createdAt", "updatedAt")
       VALUES ($1, $2, 'EDITOR', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [workspaceId, editor.userId],
    );

    await request(app.getHttpServer())
      .get(`/v1/workspaces/${workspaceId}`)
      .set(authorize(owner.accessToken))
      .expect(200)
      .expect({ id: workspaceId, name: 'Owner workspace', role: 'OWNER' });
    await request(app.getHttpServer())
      .get(`/v1/workspaces/${workspaceId}`)
      .set(authorize(editor.accessToken))
      .expect(200)
      .expect({ id: workspaceId, name: 'Owner workspace', role: 'EDITOR' });
    const hidden = await request(app.getHttpServer())
      .get(`/v1/workspaces/${workspaceId}`)
      .set(authorize(outsider.accessToken))
      .expect(404);
    expect(errorCode(hidden)).toBe('NOT_FOUND');

    const outsiderWorkspace = await request(app.getHttpServer())
      .post('/v1/workspaces')
      .set(authorize(outsider.accessToken))
      .send({ name: 'Outsider workspace' })
      .expect(201);
    const outsiderBody: unknown = outsiderWorkspace.body;
    if (
      typeof outsiderBody !== 'object' ||
      outsiderBody === null ||
      !('id' in outsiderBody) ||
      typeof outsiderBody.id !== 'string'
    ) {
      throw new Error('Expected an outsider workspace id');
    }
    const crossTenantMutation = await request(app.getHttpServer())
      .patch(
        `/v1/workspaces/${outsiderBody.id}/members/${outsider.userId}/role`,
      )
      .set(authorize(owner.accessToken))
      .send({ role: 'EDITOR' })
      .expect(404);
    expect(errorCode(crossTenantMutation)).toBe('NOT_FOUND');

    const editorDenied = await request(app.getHttpServer())
      .patch(`/v1/workspaces/${workspaceId}/members/${randomUUID()}/role`)
      .set(authorize(editor.accessToken))
      .send({ role: 'EDITOR' })
      .expect(403);
    expect(errorCode(editorDenied)).toBe('FORBIDDEN');
    const lastOwner = await request(app.getHttpServer())
      .patch(`/v1/workspaces/${workspaceId}/members/${owner.userId}/role`)
      .set(authorize(owner.accessToken))
      .send({ role: 'EDITOR' })
      .expect(409);
    expect(errorCode(lastOwner)).toBe('LAST_WORKSPACE_OWNER');

    const promotion = await request(app.getHttpServer())
      .patch(`/v1/workspaces/${workspaceId}/members/${editor.userId}/role`)
      .set(authorize(owner.accessToken))
      .send({ role: 'OWNER' })
      .expect(200);
    expect(promotion.body).toEqual({
      workspaceId,
      userId: editor.userId,
      role: 'OWNER',
    });
    const requestId: unknown = promotion.headers['x-request-id'];
    expect(typeof requestId).toBe('string');
    const audit = await pool.query<{
      action: string;
      actorUserId: string;
      metadata: unknown;
      requestId: string;
      resourceId: string;
      workspaceId: string;
    }>(
      `SELECT "workspaceId", "actorUserId", "action", "resourceId", "metadata", "requestId"
         FROM "AuditEvent"
        ORDER BY "sequence"`,
    );
    expect(audit.rows).toEqual([
      {
        workspaceId,
        actorUserId: owner.userId,
        action: 'MEMBERSHIP_ROLE_CHANGED',
        resourceId: `${workspaceId}:${editor.userId}`,
        metadata: { fromRole: 'EDITOR', toRole: 'OWNER' },
        requestId,
      },
    ]);
  });

  it('rolls membership changes back when audit append fails', async () => {
    const owner = await createVerifiedSession(
      app,
      pool,
      'audit-owner@example.test',
    );
    const editor = await createVerifiedSession(
      app,
      pool,
      'audit-editor@example.test',
    );
    const workspace = await request(app.getHttpServer())
      .post('/v1/workspaces')
      .set(authorize(owner.accessToken))
      .send({ name: 'Atomic audit workspace' })
      .expect(201);
    const body: unknown = workspace.body;
    if (
      typeof body !== 'object' ||
      body === null ||
      !('id' in body) ||
      typeof body.id !== 'string'
    ) {
      throw new Error('Expected a workspace id');
    }
    await pool.query(
      `INSERT INTO "Membership"
         ("workspaceId", "userId", "role", "createdAt", "updatedAt")
       VALUES ($1, $2, 'EDITOR', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [body.id, editor.userId],
    );

    const failingAudit: AuditWriter = {
      append: () => Promise.reject(new Error('audit unavailable')),
    };
    const failingApp = await createApplication({ audit: failingAudit });
    try {
      await request(failingApp.getHttpServer())
        .patch(`/v1/workspaces/${body.id}/members/${editor.userId}/role`)
        .set(authorize(owner.accessToken))
        .send({ role: 'OWNER' })
        .expect(500);
    } finally {
      await failingApp.close();
    }
    const membership = await pool.query<{ role: string }>(
      `SELECT "role"::text AS "role"
         FROM "Membership"
        WHERE "workspaceId" = $1 AND "userId" = $2`,
      [body.id, editor.userId],
    );
    expect(membership.rows).toEqual([{ role: 'EDITOR' }]);
    await expect(
      pool.query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM "AuditEvent"',
      ),
    ).resolves.toMatchObject({ rows: [{ count: '0' }] });
  });

  it('serializes concurrent owner demotions and preserves one owner', async () => {
    const firstOwner = await createVerifiedSession(
      app,
      pool,
      'first-owner@example.test',
    );
    const secondOwner = await createVerifiedSession(
      app,
      pool,
      'second-owner@example.test',
    );
    const workspace = await request(app.getHttpServer())
      .post('/v1/workspaces')
      .set(authorize(firstOwner.accessToken))
      .send({ name: 'Concurrent owners' })
      .expect(201);
    const body: unknown = workspace.body;
    if (
      typeof body !== 'object' ||
      body === null ||
      !('id' in body) ||
      typeof body.id !== 'string'
    ) {
      throw new Error('Expected a workspace id');
    }
    await pool.query(
      `INSERT INTO "Membership"
         ("workspaceId", "userId", "role", "createdAt", "updatedAt")
       VALUES ($1, $2, 'OWNER', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [body.id, secondOwner.userId],
    );

    const responses = await Promise.all([
      request(app.getHttpServer())
        .patch(`/v1/workspaces/${body.id}/members/${firstOwner.userId}/role`)
        .set(authorize(firstOwner.accessToken))
        .send({ role: 'EDITOR' }),
      request(app.getHttpServer())
        .patch(`/v1/workspaces/${body.id}/members/${secondOwner.userId}/role`)
        .set(authorize(secondOwner.accessToken))
        .send({ role: 'EDITOR' }),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    const owners = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM "Membership"
        WHERE "workspaceId" = $1 AND "role" = 'OWNER'`,
      [body.id],
    );
    expect(owners.rows).toEqual([{ count: '1' }]);
    const auditEvents = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM "AuditEvent"
        WHERE "workspaceId" = $1 AND "action" = 'MEMBERSHIP_ROLE_CHANGED'`,
      [body.id],
    );
    expect(auditEvents.rows).toEqual([{ count: '1' }]);
  });
});
