import { Inject, Injectable } from '@nestjs/common';
import { PrismaClientService } from '../../../shared/database/prisma.service';
import type { TransactionContext } from '../../../shared/database/transaction-runner';
import {
  PrismaTransactionClientService,
  TransactionRunner,
} from '../../../shared/database/transaction-runner';
import type {
  ChangeMembershipRoleResult,
  WorkspaceRepository,
  WorkspaceRole,
  WorkspaceView,
} from '../application/workspace.ports';

interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly role: WorkspaceRole;
}

interface MembershipRow {
  readonly role: WorkspaceRole;
  readonly userId: string;
}

interface WorkspacePrismaClient {
  $queryRawUnsafe<T>(
    statement: string,
    ...values: readonly unknown[]
  ): Promise<T>;
}

interface WorkspaceTransactionClient {
  $executeRawUnsafe(
    statement: string,
    ...values: readonly unknown[]
  ): Promise<number>;
  $queryRawUnsafe<T>(
    statement: string,
    ...values: readonly unknown[]
  ): Promise<T>;
  readonly membership: {
    create(arguments_: {
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<unknown>;
  };
  readonly workspace: {
    create(arguments_: {
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<unknown>;
  };
}

@Injectable()
export class PrismaWorkspaceRepository implements WorkspaceRepository {
  constructor(
    @Inject(PrismaClientService)
    private readonly prisma: WorkspacePrismaClient,
    private readonly transactions: TransactionRunner,
  ) {}

  async create(
    context: TransactionContext,
    input: {
      readonly id: string;
      readonly name: string;
      readonly ownerUserId: string;
    },
  ): Promise<WorkspaceView> {
    return this.withTransaction(context, async (transaction) => {
      await transaction.workspace.create({
        data: { id: input.id, name: input.name },
      });
      await transaction.membership.create({
        data: {
          workspaceId: input.id,
          userId: input.ownerUserId,
          role: 'OWNER',
        },
      });
      return { id: input.id, name: input.name, role: 'OWNER' };
    });
  }

  async findForUser(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceView | null> {
    const rows = await this.prisma.$queryRawUnsafe<WorkspaceRow[]>(
      `SELECT w."id", w."name", m."role"::text AS "role"
         FROM "Workspace" w
         JOIN "Membership" m ON m."workspaceId" = w."id"
        WHERE w."id" = $1::uuid AND m."userId" = $2::uuid`,
      workspaceId,
      userId,
    );
    return rows[0] ?? null;
  }

  async changeMembershipRole(
    context: TransactionContext,
    input: {
      readonly actorUserId: string;
      readonly role: WorkspaceRole;
      readonly targetUserId: string;
      readonly workspaceId: string;
    },
  ): Promise<ChangeMembershipRoleResult> {
    return this.withTransaction(context, async (transaction) => {
      const memberships = await transaction.$queryRawUnsafe<MembershipRow[]>(
        `SELECT "userId", "role"::text AS "role"
           FROM "Membership"
          WHERE "workspaceId" = $1::uuid
            AND "userId" IN ($2::uuid, $3::uuid)
          ORDER BY "userId"
          FOR UPDATE`,
        input.workspaceId,
        input.actorUserId,
        input.targetUserId,
      );
      const actor = memberships.find(
        ({ userId }) => userId === input.actorUserId,
      );
      const target = memberships.find(
        ({ userId }) => userId === input.targetUserId,
      );
      if (actor === undefined) {
        return { kind: 'not-found' };
      }
      if (actor.role !== 'OWNER') {
        return { kind: 'forbidden' };
      }
      if (target === undefined) {
        return { kind: 'not-found' };
      }
      const membership = {
        workspaceId: input.workspaceId,
        userId: input.targetUserId,
        role: input.role,
      };
      if (target.role === input.role) {
        return { kind: 'unchanged', membership };
      }
      if (target.role === 'OWNER' && input.role === 'EDITOR') {
        const owners = await transaction.$queryRawUnsafe<MembershipRow[]>(
          `SELECT "userId", "role"::text AS "role"
             FROM "Membership"
            WHERE "workspaceId" = $1::uuid AND "role" = 'OWNER'
            ORDER BY "userId"
            FOR UPDATE`,
          input.workspaceId,
        );
        if (owners.length <= 1) {
          return { kind: 'last-owner' };
        }
      }
      await transaction.$executeRawUnsafe(
        `UPDATE "Membership"
            SET "role" = $3::"WorkspaceRole", "updatedAt" = now()
          WHERE "workspaceId" = $1::uuid AND "userId" = $2::uuid`,
        input.workspaceId,
        input.targetUserId,
        input.role,
      );
      return { kind: 'changed', fromRole: target.role, membership };
    });
  }

  private async withTransaction<T>(
    context: TransactionContext,
    work: (transaction: WorkspaceTransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.transactions[PrismaTransactionClientService](
      context,
      (client) => work(client as WorkspaceTransactionClient),
    );
  }
}
