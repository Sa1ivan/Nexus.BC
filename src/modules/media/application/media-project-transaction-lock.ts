import { Injectable } from '@nestjs/common';
import { projectAdvisoryLockId } from '../../../shared/database/project-transaction-lock';
import type { TransactionContext } from '../../../shared/database/transaction-runner';
import { TransactionRunner } from '../../../shared/database/transaction-runner';

@Injectable()
export class MediaProjectTransactionLock {
  constructor(private readonly transactions: TransactionRunner) {}

  async acquire(context: TransactionContext, projectId: string): Promise<void> {
    await this.transactions.executeRawUnsafe(
      context,
      'SELECT pg_advisory_xact_lock($1::bigint)',
      projectAdvisoryLockId(projectId),
    );
  }
}
