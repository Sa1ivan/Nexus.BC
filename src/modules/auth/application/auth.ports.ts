import type { TransactionContext } from '../../../shared/database/transaction-runner';
import type { AuthenticatedPrincipal } from './public';

export const AUTH_REPOSITORY = Symbol('AuthRepository');
export const PASSWORD_HASHER = Symbol('PasswordHasher');
export const AUTH_SECRET_SERVICE = Symbol('AuthSecretService');
export const ACCESS_TOKEN_SERVICE = Symbol('AccessTokenService');

export interface AuthUserRecord extends AuthenticatedPrincipal {
  readonly emailVerifiedAt: Date | null;
  readonly passwordHash: string;
}

export interface RegistrationWrite {
  readonly email: string;
  readonly passwordHash: string;
  readonly token: {
    readonly expiresAt: Date;
    readonly id: string;
    readonly tokenHash: string;
  };
  readonly userId: string;
}

export interface RefreshSessionWrite {
  readonly expiresAt: Date;
  readonly familyId: string;
  readonly id: string;
  readonly tokenHash: string;
  readonly userId: string;
}

export interface RefreshReplacement {
  readonly expiresAt: Date;
  readonly id: string;
  readonly tokenHash: string;
}

export type RefreshRotationResult =
  | {
      readonly kind: 'rotated';
      readonly principal: AuthenticatedPrincipal;
    }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'reused' };

export interface PasswordResetWrite {
  readonly expiresAt: Date;
  readonly id: string;
  readonly tokenHash: string;
  readonly userId: string;
}

export interface AuthRepository {
  findUserByEmail(email: string): Promise<AuthUserRecord | null>;
  createRegistration(
    context: TransactionContext,
    write: RegistrationWrite,
  ): Promise<void>;
  consumeEmailVerification(
    context: TransactionContext,
    tokenHash: string,
    now: Date,
  ): Promise<boolean>;
  createRefreshSession(
    context: TransactionContext,
    write: RefreshSessionWrite,
    expectedPasswordHash: string,
  ): Promise<boolean>;
  rotateRefreshSession(
    context: TransactionContext,
    currentTokenHash: string,
    replacement: RefreshReplacement,
    now: Date,
  ): Promise<RefreshRotationResult>;
  revokeRefreshSessionFamily(
    context: TransactionContext,
    tokenHash: string,
    now: Date,
  ): Promise<void>;
  createPasswordReset(
    context: TransactionContext,
    write: PasswordResetWrite,
  ): Promise<void>;
  consumePasswordReset(
    context: TransactionContext,
    tokenHash: string,
    passwordHash: string,
    now: Date,
  ): Promise<boolean>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
  spendFailureBudget(password: string): Promise<void>;
}

export interface AuthSecretService {
  generate(): string;
  hash(secret: string): string;
  encrypt(secret: string): Uint8Array;
}

export interface AccessTokenService {
  sign(principal: AuthenticatedPrincipal): string;
  verify(accessToken: string): AuthenticatedPrincipal | null;
}
