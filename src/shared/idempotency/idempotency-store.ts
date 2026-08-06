import type { TransactionContext } from '../database/transaction-runner';

export const IDEMPOTENCY_STORE = Symbol('IdempotencyStore');

declare const versionedRequestFingerprintBrand: unique symbol;

export type VersionedRequestFingerprint = string & {
  readonly [versionedRequestFingerprintBrand]: true;
};

const versionedRequestFingerprintPattern =
  /^hmac-sha256:v[1-9]\d*:[0-9a-f]{64}$/u;

export function versionedRequestFingerprint(
  value: string,
): VersionedRequestFingerprint {
  if (!versionedRequestFingerprintPattern.test(value)) {
    throw new Error('Idempotency requestFingerprint is not versioned');
  }
  return value as VersionedRequestFingerprint;
}

export interface IdempotencyRecordKey {
  readonly scope: string;
  readonly operation: string;
  readonly key: string;
}

export interface IdempotencyResponseBody {
  readonly accepted?: true;
  readonly code?: string;
  readonly draftVersion?: number;
  readonly id?: string;
  readonly projectId?: string;
  readonly publicSlug?: string;
  readonly publicUrl?: string;
  readonly releaseId?: string;
  readonly schemaVersion?: number;
  readonly status?: string;
  readonly submissionId?: string;
  readonly version?: number;
  readonly workspaceId?: string;
}

export interface NewIdempotencyRecord extends IdempotencyRecordKey {
  readonly requestFingerprint: VersionedRequestFingerprint;
  readonly httpStatus: number;
  readonly responseBody: IdempotencyResponseBody;
  readonly resourceId: string | null;
}

export interface StoredIdempotencyRecord extends NewIdempotencyRecord {
  readonly createdAt: Date;
  readonly completedAt: Date;
}

export interface IdempotencyRecordStore {
  read(
    context: TransactionContext,
    key: IdempotencyRecordKey,
  ): Promise<StoredIdempotencyRecord | null>;
  create(
    context: TransactionContext,
    record: NewIdempotencyRecord,
  ): Promise<StoredIdempotencyRecord>;
  clearResourceId(
    context: TransactionContext,
    resourceId: string,
  ): Promise<number>;
}
