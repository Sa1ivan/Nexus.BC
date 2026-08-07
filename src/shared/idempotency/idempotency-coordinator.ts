import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.schema';
import type { TransactionContext } from '../database/transaction-runner';
import { TransactionRunner } from '../database/transaction-runner';
import {
  IDEMPOTENCY_STORE,
  type IdempotencyRecordKey,
  type IdempotencyRecordStore,
  type IdempotencyResponseBody,
  type StoredIdempotencyRecord,
} from './idempotency-store';
import {
  createRequestFingerprint,
  verifyRequestFingerprint,
} from './request-fingerprint';

export interface IdempotencyCommandResult<T> {
  readonly httpStatus: number;
  readonly responseBody: IdempotencyResponseBody;
  readonly resourceId: string | null;
  readonly result: T;
}

export type IdempotencyExecution<T> =
  | {
      readonly kind: 'executed';
      readonly record: StoredIdempotencyRecord;
      readonly result: T;
    }
  | {
      readonly kind: 'replayed';
      readonly record: StoredIdempotencyRecord;
    }
  | { readonly kind: 'key-reused' };

@Injectable()
export class IdempotencyCoordinator {
  constructor(
    private readonly transactions: TransactionRunner,
    @Inject(IDEMPOTENCY_STORE)
    private readonly records: IdempotencyRecordStore,
    @Inject(APP_CONFIG) private readonly configuration: AppConfig,
  ) {}

  async execute<T>(input: {
    readonly key: IdempotencyRecordKey;
    readonly request: unknown;
    readonly command: (
      context: TransactionContext,
    ) => Promise<IdempotencyCommandResult<T>>;
  }): Promise<IdempotencyExecution<T>> {
    const requestFingerprint = createRequestFingerprint(
      input.request,
      this.configuration.idempotencyHmacActiveKeyVersion,
      this.configuration.idempotencyHmacKeyring,
    );

    return this.transactions.run(async (context) => {
      await this.records.acquireLock(context, input.key);
      const stored = await this.records.read(context, input.key);
      if (stored !== null) {
        this.assertVerificationKeyAvailable(stored.requestFingerprint);
        return verifyRequestFingerprint(
          stored.requestFingerprint,
          input.request,
          this.configuration.idempotencyHmacKeyring,
        )
          ? { kind: 'replayed', record: stored }
          : { kind: 'key-reused' };
      }

      const completed = await input.command(context);
      if (
        !Number.isInteger(completed.httpStatus) ||
        completed.httpStatus < 200 ||
        completed.httpStatus >= 500
      ) {
        throw new Error(
          'Idempotency commands may persist only non-5xx results',
        );
      }
      const record = await this.records.create(context, {
        ...input.key,
        requestFingerprint,
        httpStatus: completed.httpStatus,
        responseBody: completed.responseBody,
        resourceId: completed.resourceId,
      });
      return { kind: 'executed', record, result: completed.result };
    });
  }

  private assertVerificationKeyAvailable(fingerprint: string): void {
    const match = /^hmac-sha256:v([1-9]\d*):[0-9a-f]{64}$/u.exec(fingerprint);
    const versionValue = match?.[1];
    if (versionValue === undefined) {
      throw new Error('Stored idempotency fingerprint is malformed');
    }
    const version = Number(versionValue);
    if (
      !Number.isSafeInteger(version) ||
      !this.configuration.idempotencyHmacKeyring.has(version)
    ) {
      throw new Error('Stored idempotency fingerprint key is unavailable');
    }
  }
}
