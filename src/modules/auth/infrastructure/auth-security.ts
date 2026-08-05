import {
  createCipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import {
  APP_CONFIG,
  type AppConfig,
} from '../../../shared/config/app-config.schema';
import type {
  AccessTokenService,
  AuthSecretService,
  PasswordHasher,
} from '../application/auth.ports';
import type { AuthenticatedPrincipal } from '../application/public';

const accessTokenLifetimeSeconds = 10 * 60;

function base64UrlJson(value: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

@Injectable()
export class Argon2idPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
      hashLength: 32,
      version: 0x13,
    });
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  async spendFailureBudget(password: string): Promise<void> {
    await this.hash(password);
  }
}

@Injectable()
export class AesGcmAuthSecretService implements AuthSecretService {
  constructor(@Inject(APP_CONFIG) private readonly configuration: AppConfig) {}

  generate(): string {
    return randomBytes(32).toString('base64url');
  }

  hash(secret: string): string {
    return createHmac('sha256', this.configuration.refreshTokenSecret)
      .update(secret, 'utf8')
      .digest('hex');
  }

  encrypt(secret: string): Uint8Array {
    const nonce = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.configuration.outboxEncryptionKey,
      nonce,
    );
    const ciphertext = Buffer.concat([
      cipher.update(secret, 'utf8'),
      cipher.final(),
    ]);
    const authenticationTag = cipher.getAuthTag();
    return Uint8Array.from([1, ...nonce, ...authenticationTag, ...ciphertext]);
  }
}

@Injectable()
export class HmacAccessTokenService implements AccessTokenService {
  constructor(@Inject(APP_CONFIG) private readonly configuration: AppConfig) {}

  sign(principal: AuthenticatedPrincipal): string {
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
    const payload = base64UrlJson({
      sub: principal.userId,
      email: principal.email,
      iat: issuedAt,
      exp: issuedAt + accessTokenLifetimeSeconds,
    });
    const unsigned = `${header}.${payload}`;
    const signature = createHmac('sha256', this.configuration.accessTokenSecret)
      .update(unsigned, 'utf8')
      .digest('base64url');
    return `${unsigned}.${signature}`;
  }

  verify(accessToken: string): AuthenticatedPrincipal | null {
    const segments = accessToken.split('.');
    if (segments.length !== 3) {
      return null;
    }
    const [header, payload, signature] = segments;
    if (
      header === undefined ||
      payload === undefined ||
      signature === undefined
    ) {
      return null;
    }
    const expected = createHmac('sha256', this.configuration.accessTokenSecret)
      .update(`${header}.${payload}`, 'utf8')
      .digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(signature, 'base64url');
    } catch {
      return null;
    }
    if (
      supplied.byteLength !== expected.byteLength ||
      !timingSafeEqual(supplied, expected)
    ) {
      return null;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (typeof decoded !== 'object' || decoded === null) {
      return null;
    }
    const claims = decoded as Readonly<Record<string, unknown>>;
    if (
      typeof claims['sub'] !== 'string' ||
      typeof claims['email'] !== 'string' ||
      typeof claims['exp'] !== 'number' ||
      !Number.isSafeInteger(claims['exp']) ||
      claims['exp'] <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return { userId: claims['sub'], email: claims['email'] };
  }
}
