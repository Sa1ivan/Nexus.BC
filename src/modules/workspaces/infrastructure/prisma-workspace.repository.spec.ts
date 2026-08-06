import { randomUUID } from 'node:crypto';
import type { PrismaTransactionHost } from '../../../shared/database/prisma.service';
import { TransactionRunner } from '../../../shared/database/transaction-runner';
import { PrismaWorkspaceRepository } from './prisma-workspace.repository';

class RoleChangeTransactionClient {
  readonly queries: string[] = [];

  constructor(
    private readonly actorUserId: string,
    private readonly targetUserId: string,
  ) {}

  $executeRawUnsafe(): Promise<number> {
    return Promise.resolve(1);
  }

  $queryRawUnsafe<T>(statement: string): Promise<T> {
    this.queries.push(statement);
    return Promise.resolve([
      { userId: this.actorUserId, role: 'OWNER' },
      { userId: this.targetUserId, role: 'EDITOR' },
    ] as unknown as T);
  }
}

describe('PrismaWorkspaceRepository role locking', () => {
  it('locks every workspace membership in canonical order before changing a role', async () => {
    const actorUserId = randomUUID();
    const targetUserId = randomUUID();
    const client = new RoleChangeTransactionClient(actorUserId, targetUserId);
    const transactionHost: PrismaTransactionHost = {
      $transaction: (work) => work(client),
    };
    const transactions = new TransactionRunner(transactionHost);
    const repository = new PrismaWorkspaceRepository(client, transactions);

    await transactions.run((context) =>
      repository.changeMembershipRole(context, {
        actorUserId,
        targetUserId,
        workspaceId: randomUUID(),
        role: 'OWNER',
      }),
    );

    expect(client.queries).toHaveLength(1);
    expect(client.queries[0]).toContain('WHERE "workspaceId" = $1::uuid');
    expect(client.queries[0]).toContain('ORDER BY "userId"');
    expect(client.queries[0]).toContain('FOR UPDATE');
    expect(client.queries[0]).not.toContain('"userId" IN');
  });
});
