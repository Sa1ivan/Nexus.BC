import type { CanActivate, INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

const allowedWebOrigin = 'https://app.nexus.site';
const allowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const allowedHeaders = [
  'Authorization',
  'Content-Type',
  'Idempotency-Key',
  'Nexus-Client-Capabilities',
];

const completeRuntimeEnvironment = {
  NODE_ENV: 'production',
  PORT: '3000',
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:1/nexus',
  WEB_ORIGINS: JSON.stringify([allowedWebOrigin]),
  BOOKING_TIME_ZONE: 'Europe/Moscow',
  PRIVACY_NOTICE_URL: 'https://app.nexus.site/privacy',
  PRIVACY_NOTICE_VERSION: 'alpha-2026-08-04',
  LEAD_RETENTION_DAYS: '90',
  ACCESS_TOKEN_SECRET: 'a'.repeat(32),
  REFRESH_TOKEN_SECRET: 'b'.repeat(32),
  R2_ACCOUNT_ID: 'test-account',
  R2_ACCESS_KEY_ID: 'test-access-key',
  R2_SECRET_ACCESS_KEY: 'c'.repeat(32),
  R2_BUCKET_NAME: 'nexus-test',
  RESEND_API_KEY: 're_test_key',
  RESEND_WEBHOOK_SIGNING_SECRET: 'whsec_test_secret',
  EMAIL_FROM: 'Nexus <noreply@nexus.site>',
  OUTBOX_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  IDEMPOTENCY_HMAC_ACTIVE_KEY_VERSION: '1',
  IDEMPOTENCY_HMAC_KEYRING: JSON.stringify({
    1: Buffer.alloc(32, 2).toString('base64'),
  }),
  SITE_CONFIG_ROLLOUT_MODE: 'V4_COMPAT',
} satisfies Record<string, string>;

const requiredOutsideTestKeys = [
  'DATABASE_URL',
  'WEB_ORIGINS',
  'ACCESS_TOKEN_SECRET',
  'REFRESH_TOKEN_SECRET',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'RESEND_API_KEY',
  'RESEND_WEBHOOK_SIGNING_SECRET',
  'EMAIL_FROM',
  'OUTBOX_ENCRYPTION_KEY',
  'IDEMPOTENCY_HMAC_ACTIVE_KEY_VERSION',
  'IDEMPOTENCY_HMAC_KEYRING',
] as const;

const managedEnvironmentKeys = Object.keys(completeRuntimeEnvironment);

const rejectingGuard: CanActivate = {
  canActivate: () => false,
};

async function createApplication(
  configure?: (app: INestApplication<App>) => void,
): Promise<INestApplication<App>> {
  let moduleFixture: TestingModule | undefined;
  let app: INestApplication<App> | undefined;

  try {
    jest.resetModules();
    const { Test } =
      jest.requireActual<typeof import('@nestjs/testing')>('@nestjs/testing');
    const { AppModule } = jest.requireActual<
      typeof import('../../src/app.module')
    >('../../src/app.module');
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configure?.(app);
    await app.init();
    return app;
  } catch (error) {
    if (app) {
      await app.close();
    } else if (moduleFixture) {
      await moduleFixture.close();
    }
    throw error;
  }
}

function replaceRuntimeEnvironment(
  environment: Readonly<Record<string, string>>,
): () => void {
  const previousValues = new Map<string, string | undefined>();

  for (const key of managedEnvironmentKeys) {
    previousValues.set(key, process.env[key]);
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(environment)) {
    process.env[key] = value;
  }

  return () => {
    for (const [key, value] of previousValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function environmentWithout(
  omittedKey: (typeof requiredOutsideTestKeys)[number],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(completeRuntimeEnvironment).filter(
      ([key]) => key !== omittedKey,
    ),
  );
}

function requireActiveApplication(
  app: INestApplication<App> | undefined,
): INestApplication<App> {
  if (!app) {
    throw new Error('Expected the test application to be initialized');
  }
  return app;
}

function expectVaryOrigin(response: request.Response): void {
  const vary = response.headers['vary'];
  if (typeof vary !== 'string') {
    throw new Error('Expected a Vary response header');
  }
  expect(vary.split(',').map((value) => value.trim())).toContain('Origin');
}

function responseHeaderTokens(
  response: request.Response,
  headerName: string,
): string[] {
  const value = response.headers[headerName];
  if (typeof value !== 'string') {
    throw new Error(`Expected a ${headerName} response header`);
  }
  return value.split(',').map((token) => token.trim());
}

function responseErrorCode(response: request.Response): unknown {
  const body: unknown = response.body;
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return undefined;
  }

  const error = body.error;
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }

  return error.code;
}

describe('runtime configuration', () => {
  it.each(requiredOutsideTestKeys)(
    'rejects non-test bootstrap when %s is missing',
    async (missingKey) => {
      const restoreEnvironment = replaceRuntimeEnvironment(
        environmentWithout(missingKey),
      );

      try {
        const initialization = createApplication().then(async (app) => {
          await app.close();
        });
        await expect(initialization).rejects.toThrow(missingKey);
      } finally {
        restoreEnvironment();
      }
    },
  );
});

describe('health and credentialed CORS', () => {
  let app: INestApplication<App> | undefined;
  let guardedApp: INestApplication<App> | undefined;
  let restoreEnvironment: (() => void) | undefined;

  beforeAll(async () => {
    restoreEnvironment = replaceRuntimeEnvironment(completeRuntimeEnvironment);
    app = await createApplication();
    guardedApp = await createApplication((application) => {
      application.useGlobalGuards(rejectingGuard);
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    if (guardedApp) {
      await guardedApp.close();
    }
    restoreEnvironment?.();
  });

  it('keeps liveness available when PostgreSQL is unavailable', async () => {
    await request(requireActiveApplication(app).getHttpServer())
      .get('/v1/health/live')
      .expect(200);
  });

  it('reports readiness unavailable when PostgreSQL is unavailable', async () => {
    await request(requireActiveApplication(app).getHttpServer())
      .get('/v1/health/ready')
      .expect(503);
  });

  it('allows an exact credentialed actual request', async () => {
    const response = await request(
      requireActiveApplication(app).getHttpServer(),
    )
      .get('/v1/health/live')
      .set('Origin', allowedWebOrigin);

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(
      allowedWebOrigin,
    );
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-allow-origin']).not.toBe('*');
    expectVaryOrigin(response);
  });

  it('answers allowed credentialed preflight before route guards', async () => {
    const response = await request(
      requireActiveApplication(guardedApp).getHttpServer(),
    )
      .options('/v1/health/live')
      .set('Origin', allowedWebOrigin)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', allowedHeaders.join(', '));

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(
      allowedWebOrigin,
    );
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(
      responseHeaderTokens(response, 'access-control-allow-methods')
        .map((method) => method.toUpperCase())
        .sort(),
    ).toEqual(allowedMethods.map((method) => method.toUpperCase()).sort());
    expect(
      responseHeaderTokens(response, 'access-control-allow-headers')
        .map((header) => header.toLowerCase())
        .sort(),
    ).toEqual(allowedHeaders.map((header) => header.toLowerCase()).sort());
    expect(response.headers['access-control-allow-origin']).not.toBe('*');
    expectVaryOrigin(response);
  });

  it('never reflects unsupported preflight methods or headers', async () => {
    const unsupportedMethod = 'TRACE';
    const unsupportedHeader = 'X-Nexus-Unsupported';
    const response = await request(
      requireActiveApplication(guardedApp).getHttpServer(),
    )
      .options('/v1/health/live')
      .set('Origin', allowedWebOrigin)
      .set('Access-Control-Request-Method', unsupportedMethod)
      .set('Access-Control-Request-Headers', unsupportedHeader);

    expect([204, 403]).toContain(response.status);
    const advertisedMethods = response.headers['access-control-allow-methods'];
    if (typeof advertisedMethods === 'string') {
      expect(advertisedMethods.toUpperCase()).not.toContain(unsupportedMethod);
    }
    const advertisedHeaders = response.headers['access-control-allow-headers'];
    if (typeof advertisedHeaders === 'string') {
      expect(advertisedHeaders.toLowerCase()).not.toContain(
        unsupportedHeader.toLowerCase(),
      );
    }
    expectVaryOrigin(response);
  });

  it.each([
    ['lookalike', 'https://app.nexus.site.evil.example'],
    ['null', 'null'],
    ['foreign', 'https://example.com'],
    ['additional valid HTTPS', 'https://admin.nexus.site'],
  ])('denies a %s origin without reflecting it', async (_kind, origin) => {
    const response = await request(
      requireActiveApplication(app).getHttpServer(),
    )
      .get('/v1/health/live')
      .set('Origin', origin);

    expect(response.status).toBe(403);
    expect(responseErrorCode(response)).toBe('CORS_ORIGIN_DENIED');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expectVaryOrigin(response);
  });
});
