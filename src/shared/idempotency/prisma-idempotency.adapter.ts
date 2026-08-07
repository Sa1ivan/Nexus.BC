import { Injectable } from '@nestjs/common';
import type { TransactionContext } from '../database/transaction-runner';
import {
  PrismaTransactionClientService,
  TransactionRunner,
} from '../database/transaction-runner';
import {
  type IdempotencyRecordKey,
  type IdempotencyRecordStore,
  type IdempotencyResponseBody,
  type NewIdempotencyRecord,
  type StoredIdempotencyRecord,
  versionedRequestFingerprint,
} from './idempotency-store';
import { idempotencyAdvisoryLockId } from './idempotency-lock';

const responseStringFields = new Set([
  'code',
  'id',
  'projectId',
  'publicSlug',
  'publicUrl',
  'releaseId',
  'status',
  'submissionId',
  'workspaceId',
]);
const responseIntegerFields = new Set([
  'draftVersion',
  'schemaVersion',
  'version',
]);
const responseFields = new Set([
  'accepted',
  ...responseStringFields,
  ...responseIntegerFields,
]);

interface IdempotencyTransactionClient {
  $executeRawUnsafe(
    statement: string,
    ...values: readonly unknown[]
  ): Promise<number>;
  readonly idempotencyRecord: {
    findUnique(arguments_: {
      readonly where: {
        readonly scope_operation_key: IdempotencyRecordKey;
      };
    }): Promise<StoredIdempotencyRecord | null>;
    create(arguments_: {
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<StoredIdempotencyRecord>;
    updateMany(arguments_: {
      readonly where: { readonly resourceId: string };
      readonly data: { readonly resourceId: null };
    }): Promise<{ readonly count: number }>;
  };
}

function assertAllowlistedResponseBody(
  responseBody: IdempotencyResponseBody,
): void {
  if (
    typeof responseBody !== 'object' ||
    responseBody === null ||
    Array.isArray(responseBody)
  ) {
    throw new Error('Idempotency responseBody is not allowlisted');
  }

  for (const [field, value] of Object.entries(responseBody)) {
    if (!responseFields.has(field)) {
      throw new Error('Idempotency responseBody is not allowlisted');
    }
    if (field === 'accepted' && value !== true) {
      throw new Error('Idempotency responseBody is not allowlisted');
    }
    if (responseStringFields.has(field) && typeof value !== 'string') {
      throw new Error('Idempotency responseBody is not allowlisted');
    }
    if (responseIntegerFields.has(field) && !Number.isInteger(value)) {
      throw new Error('Idempotency responseBody is not allowlisted');
    }
  }
}

function copyResponseBody(
  responseBody: IdempotencyResponseBody,
): IdempotencyResponseBody {
  return Object.fromEntries(Object.entries(responseBody));
}

function copyStoredRecord(
  record: StoredIdempotencyRecord,
): StoredIdempotencyRecord {
  const requestFingerprint = versionedRequestFingerprint(
    record.requestFingerprint,
  );
  assertAllowlistedResponseBody(record.responseBody);
  return {
    scope: record.scope,
    operation: record.operation,
    key: record.key,
    requestFingerprint,
    httpStatus: record.httpStatus,
    responseBody: copyResponseBody(record.responseBody),
    resourceId: record.resourceId,
    createdAt: new Date(record.createdAt.getTime()),
    completedAt: new Date(record.completedAt.getTime()),
  };
}

@Injectable()
export class PrismaIdempotencyAdapter implements IdempotencyRecordStore {
  constructor(private readonly transactions: TransactionRunner) {}

  async acquireLock(
    context: TransactionContext,
    key: IdempotencyRecordKey,
  ): Promise<void> {
    await this.transactions[PrismaTransactionClientService](
      context,
      async (client) => {
        const transaction = client as IdempotencyTransactionClient;
        await transaction.$executeRawUnsafe(
          'SELECT pg_advisory_xact_lock($1::bigint)',
          idempotencyAdvisoryLockId(key).toString(),
        );
      },
    );
  }

  async read(
    context: TransactionContext,
    key: IdempotencyRecordKey,
  ): Promise<StoredIdempotencyRecord | null> {
    return this.transactions[PrismaTransactionClientService](
      context,
      async (client) => {
        const transaction = client as IdempotencyTransactionClient;
        const record = await transaction.idempotencyRecord.findUnique({
          where: {
            scope_operation_key: {
              scope: key.scope,
              operation: key.operation,
              key: key.key,
            },
          },
        });
        return record === null ? null : copyStoredRecord(record);
      },
    );
  }

  async create(
    context: TransactionContext,
    record: NewIdempotencyRecord,
  ): Promise<StoredIdempotencyRecord> {
    versionedRequestFingerprint(record.requestFingerprint);
    assertAllowlistedResponseBody(record.responseBody);

    return this.transactions[PrismaTransactionClientService](
      context,
      async (client) => {
        const transaction = client as IdempotencyTransactionClient;
        const created = await transaction.idempotencyRecord.create({
          data: {
            scope: record.scope,
            operation: record.operation,
            key: record.key,
            requestFingerprint: record.requestFingerprint,
            httpStatus: record.httpStatus,
            responseBody: copyResponseBody(record.responseBody),
            resourceId: record.resourceId,
          },
        });
        return copyStoredRecord(created);
      },
    );
  }

  async clearResourceId(
    context: TransactionContext,
    resourceId: string,
  ): Promise<number> {
    return this.transactions[PrismaTransactionClientService](
      context,
      async (client) => {
        const transaction = client as IdempotencyTransactionClient;
        const result = await transaction.idempotencyRecord.updateMany({
          where: { resourceId },
          data: { resourceId: null },
        });
        return result.count;
      },
    );
  }
}
