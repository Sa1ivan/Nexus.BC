import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { TransactionRunner } from '../../../shared/database/transaction-runner';
import {
  WORKSPACE_REPOSITORY,
  type WorkspaceRepository,
  type WorkspaceView,
} from './workspace.ports';

@Injectable()
export class CreateWorkspace {
  constructor(
    @Inject(WORKSPACE_REPOSITORY)
    private readonly repository: WorkspaceRepository,
    private readonly transactions: TransactionRunner,
  ) {}

  execute(ownerUserId: string, name: string): Promise<WorkspaceView> {
    return this.transactions.run((context) =>
      this.repository.create(context, {
        id: randomUUID(),
        name,
        ownerUserId,
      }),
    );
  }
}
