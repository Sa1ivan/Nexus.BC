export type NodeEnvironment = 'development' | 'test' | 'production';
export type SiteConfigRolloutMode = 'V4_COMPAT' | 'V5_ACTIVE';
export type WebOrigin = string;

export interface R2Config {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucketName: string;
}

export interface ResendConfig {
  readonly apiKey: string;
  readonly webhookSigningSecret: string;
}

export interface AppConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly port: number;
  readonly databaseUrl: string;
  readonly webOrigins: readonly WebOrigin[];
  readonly bookingTimeZone: string;
  readonly privacyNoticeUrl: string;
  readonly privacyNoticeVersion: string;
  readonly leadRetentionDays: number;
  readonly accessTokenSecret: string;
  readonly refreshTokenSecret: string;
  readonly r2: R2Config;
  readonly resend: ResendConfig;
  readonly emailFrom: string;
  readonly outboxEncryptionKey: Buffer;
  readonly idempotencyHmacActiveKeyVersion: number;
  readonly idempotencyHmacKeyring: ReadonlyMap<number, Buffer>;
  readonly siteConfigRolloutMode: SiteConfigRolloutMode;
}

export const APP_CONFIG = 'APP_CONFIG';

const productionWebOrigin = 'https://app.nexus.site';

const testDefaults = {
  DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/nexus_test',
  WEB_ORIGINS: JSON.stringify(['http://localhost:4200']),
  PRIVACY_NOTICE_URL: 'http://localhost:4200/privacy',
  PRIVACY_NOTICE_VERSION: 'test',
  ACCESS_TOKEN_SECRET: 'test-access-token-secret-32-bytes',
  REFRESH_TOKEN_SECRET: 'test-refresh-token-secret-32-byte',
  R2_ACCOUNT_ID: 'test-account',
  R2_ACCESS_KEY_ID: 'test-access-key',
  R2_SECRET_ACCESS_KEY: 'test-secret-key',
  R2_BUCKET_NAME: 'nexus-test',
  RESEND_API_KEY: 're_test',
  RESEND_WEBHOOK_SIGNING_SECRET: 'whsec_test',
  EMAIL_FROM: 'Nexus Test <noreply@example.test>',
  OUTBOX_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  IDEMPOTENCY_HMAC_ACTIVE_KEY_VERSION: '1',
  IDEMPOTENCY_HMAC_KEYRING: JSON.stringify({
    1: Buffer.alloc(32, 2).toString('base64'),
  }),
} satisfies Readonly<Record<string, string>>;

function configurationError(key: string, message: string): Error {
  return new Error(`${key}: ${message}`);
}

function parseNodeEnvironment(value: string | undefined): NodeEnvironment {
  const nodeEnvironment = value ?? 'development';
  if (
    nodeEnvironment !== 'development' &&
    nodeEnvironment !== 'test' &&
    nodeEnvironment !== 'production'
  ) {
    throw configurationError(
      'NODE_ENV',
      'must be development, test, or production',
    );
  }
  return nodeEnvironment;
}

function requiredValue(
  environment: NodeJS.ProcessEnv,
  key: keyof typeof testDefaults,
  nodeEnvironment: NodeEnvironment,
): string {
  const value =
    environment[key] ??
    (nodeEnvironment === 'test' ? testDefaults[key] : undefined);
  if (value === undefined || value.trim().length === 0) {
    throw configurationError(key, 'is required');
  }
  return value;
}

function requiredSecret(
  environment: NodeJS.ProcessEnv,
  key: 'ACCESS_TOKEN_SECRET' | 'REFRESH_TOKEN_SECRET',
  nodeEnvironment: NodeEnvironment,
): string {
  const value = requiredValue(environment, key, nodeEnvironment);
  if (value.length < 32) {
    throw configurationError(key, 'must contain at least 32 characters');
  }
  return value;
}

function parseInteger(
  key: string,
  value: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^\d+$/.test(value)) {
    throw configurationError(key, 'must be an integer');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw configurationError(key, `must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseWebOrigins(
  value: string,
  nodeEnvironment: NodeEnvironment,
): readonly WebOrigin[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw configurationError('WEB_ORIGINS', 'must be a JSON array');
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw configurationError('WEB_ORIGINS', 'must be a non-empty JSON array');
  }

  const origins = parsed.map((candidate: unknown) => {
    if (typeof candidate !== 'string') {
      throw configurationError('WEB_ORIGINS', 'entries must be strings');
    }

    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw configurationError('WEB_ORIGINS', 'entries must be valid origins');
    }

    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      candidate !== url.origin
    ) {
      throw configurationError(
        'WEB_ORIGINS',
        'entries must be normalized HTTP(S) origins',
      );
    }
    if (nodeEnvironment === 'production' && url.protocol !== 'https:') {
      throw configurationError(
        'WEB_ORIGINS',
        'production origins must use HTTPS',
      );
    }
    return candidate;
  });

  if (new Set(origins).size !== origins.length) {
    throw configurationError('WEB_ORIGINS', 'entries must be unique');
  }
  if (
    nodeEnvironment === 'production' &&
    (origins.length !== 1 || origins[0] !== productionWebOrigin)
  ) {
    throw configurationError(
      'WEB_ORIGINS',
      `production must allow only ${productionWebOrigin}`,
    );
  }
  return origins;
}

function parseTimeZone(value: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
  } catch {
    throw configurationError('BOOKING_TIME_ZONE', 'must be an IANA time zone');
  }
  return value;
}

function parsePrivacyNoticeUrl(
  value: string,
  nodeEnvironment: NodeEnvironment,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError('PRIVACY_NOTICE_URL', 'must be an absolute URL');
  }
  if (nodeEnvironment === 'production' && url.protocol !== 'https:') {
    throw configurationError(
      'PRIVACY_NOTICE_URL',
      'production URL must use HTTPS',
    );
  }
  return url.toString();
}

function parseBase64Key(
  key: string,
  value: string,
  minimumBytes: number,
  exact = false,
): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw configurationError(key, 'must be canonical base64');
  }
  if (
    (exact && decoded.byteLength !== minimumBytes) ||
    (!exact && decoded.byteLength < minimumBytes)
  ) {
    throw configurationError(
      key,
      exact
        ? `must contain exactly ${minimumBytes} bytes`
        : `must contain at least ${minimumBytes} bytes`,
    );
  }
  return decoded;
}

function parseIdempotencyKeyring(value: string): ReadonlyMap<number, Buffer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw configurationError(
      'IDEMPOTENCY_HMAC_KEYRING',
      'must be a JSON object',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw configurationError(
      'IDEMPOTENCY_HMAC_KEYRING',
      'must be a JSON object',
    );
  }

  const keyring = new Map<number, Buffer>();
  for (const [rawVersion, rawKey] of Object.entries(parsed)) {
    const version = parseInteger(
      'IDEMPOTENCY_HMAC_KEYRING',
      rawVersion,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (rawVersion !== String(version)) {
      throw configurationError(
        'IDEMPOTENCY_HMAC_KEYRING',
        'versions must be canonical positive integers',
      );
    }
    if (typeof rawKey !== 'string') {
      throw configurationError(
        'IDEMPOTENCY_HMAC_KEYRING',
        'keys must be base64 strings',
      );
    }
    keyring.set(
      version,
      parseBase64Key('IDEMPOTENCY_HMAC_KEYRING', rawKey, 32),
    );
  }
  if (keyring.size === 0) {
    throw configurationError(
      'IDEMPOTENCY_HMAC_KEYRING',
      'must contain at least one key',
    );
  }
  return keyring;
}

function parseRolloutMode(value: string | undefined): SiteConfigRolloutMode {
  const mode = value ?? 'V4_COMPAT';
  if (mode !== 'V4_COMPAT' && mode !== 'V5_ACTIVE') {
    throw configurationError(
      'SITE_CONFIG_ROLLOUT_MODE',
      'must be V4_COMPAT or V5_ACTIVE',
    );
  }
  return mode;
}

export function loadAppConfig() {
  const environment = process.env;
  const nodeEnv = parseNodeEnvironment(environment['NODE_ENV']);
  const activeKeyVersion = parseInteger(
    'IDEMPOTENCY_HMAC_ACTIVE_KEY_VERSION',
    requiredValue(environment, 'IDEMPOTENCY_HMAC_ACTIVE_KEY_VERSION', nodeEnv),
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const idempotencyHmacKeyring = parseIdempotencyKeyring(
    requiredValue(environment, 'IDEMPOTENCY_HMAC_KEYRING', nodeEnv),
  );
  if (!idempotencyHmacKeyring.has(activeKeyVersion)) {
    throw configurationError(
      'IDEMPOTENCY_HMAC_ACTIVE_KEY_VERSION',
      'must select a keyring entry',
    );
  }

  return {
    nodeEnv,
    port: parseInteger('PORT', environment['PORT'] ?? '3000', 1, 65_535),
    databaseUrl: requiredValue(environment, 'DATABASE_URL', nodeEnv),
    webOrigins: parseWebOrigins(
      requiredValue(environment, 'WEB_ORIGINS', nodeEnv),
      nodeEnv,
    ),
    bookingTimeZone: parseTimeZone(
      environment['BOOKING_TIME_ZONE'] ?? 'Europe/Moscow',
    ),
    privacyNoticeUrl: parsePrivacyNoticeUrl(
      requiredValue(environment, 'PRIVACY_NOTICE_URL', nodeEnv),
      nodeEnv,
    ),
    privacyNoticeVersion: requiredValue(
      environment,
      'PRIVACY_NOTICE_VERSION',
      nodeEnv,
    ),
    leadRetentionDays: parseInteger(
      'LEAD_RETENTION_DAYS',
      environment['LEAD_RETENTION_DAYS'] ?? '90',
      1,
      365,
    ),
    accessTokenSecret: requiredSecret(
      environment,
      'ACCESS_TOKEN_SECRET',
      nodeEnv,
    ),
    refreshTokenSecret: requiredSecret(
      environment,
      'REFRESH_TOKEN_SECRET',
      nodeEnv,
    ),
    r2: {
      accountId: requiredValue(environment, 'R2_ACCOUNT_ID', nodeEnv),
      accessKeyId: requiredValue(environment, 'R2_ACCESS_KEY_ID', nodeEnv),
      secretAccessKey: requiredValue(
        environment,
        'R2_SECRET_ACCESS_KEY',
        nodeEnv,
      ),
      bucketName: requiredValue(environment, 'R2_BUCKET_NAME', nodeEnv),
    },
    resend: {
      apiKey: requiredValue(environment, 'RESEND_API_KEY', nodeEnv),
      webhookSigningSecret: requiredValue(
        environment,
        'RESEND_WEBHOOK_SIGNING_SECRET',
        nodeEnv,
      ),
    },
    emailFrom: requiredValue(environment, 'EMAIL_FROM', nodeEnv),
    outboxEncryptionKey: parseBase64Key(
      'OUTBOX_ENCRYPTION_KEY',
      requiredValue(environment, 'OUTBOX_ENCRYPTION_KEY', nodeEnv),
      32,
      true,
    ),
    idempotencyHmacActiveKeyVersion: activeKeyVersion,
    idempotencyHmacKeyring,
    siteConfigRolloutMode: parseRolloutMode(
      environment['SITE_CONFIG_ROLLOUT_MODE'],
    ),
  } satisfies AppConfig;
}
