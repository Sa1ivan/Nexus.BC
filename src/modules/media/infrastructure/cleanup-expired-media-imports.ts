import { Inject, Injectable } from '@nestjs/common';
import { PrismaClientService } from '../../../shared/database/prisma.service';
import {
  PrismaTransactionClientService,
  TransactionRunner,
} from '../../../shared/database/transaction-runner';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
  restorePersistedMediaObjectKey,
} from '../application/ports/object-storage';

const CLEANUP_BATCH_LIMIT = 100;
const CLEANUP_OBJECT_ATTEMPT_LIMIT = 60;
const BATCH_OBJECT_ATTEMPT_RESERVATION = 30;
const PENDING_PROJECT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1_000;

interface ExpiredBatchCandidate {
  readonly id: string;
  readonly workspaceId: string;
  readonly expiresAt: Date;
  readonly attachedAt: Date | null;
  readonly cleanupLastAttemptAt: Date | null;
}

interface CleanupAssetRow {
  readonly id: string;
  readonly objectKey: string;
  readonly cleanupLastAttemptAt: Date | null;
}

interface CleanupResult {
  readonly completed: number;
  readonly failures: number;
}

interface ProjectCleanupCandidate extends CleanupAssetRow {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly importBatchId: string | null;
  readonly status: 'PENDING' | 'DELETING';
  readonly createdAt: Date;
  readonly cleanupStartedAt: Date | null;
  readonly cleanupLastAttemptAt: Date | null;
}

interface CleanupPrismaClient {
  $executeRaw(
    query: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<number>;
  $queryRaw<T>(
    query: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<T>;
}

@Injectable()
export class CleanupExpiredMediaImports {
  constructor(
    @Inject(PrismaClientService)
    private readonly prisma: CleanupPrismaClient,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(now: Date): Promise<number> {
    const candidates = await this.prisma.$queryRaw<
      readonly ExpiredBatchCandidate[]
    >`
      SELECT "id", "workspaceId", "expiresAt", "attachedAt", "cleanupLastAttemptAt"
      FROM "MediaImportBatch"
      WHERE "expiresAt" <= ${now}
        AND "attachedAt" IS NULL
      ORDER BY COALESCE("cleanupLastAttemptAt", "expiresAt"), "id"
      LIMIT ${CLEANUP_BATCH_LIMIT}
    `;
    let completed = 0;
    let failures = 0;
    let batchAttempts = 0;
    for (const candidate of candidates) {
      if (batchAttempts >= BATCH_OBJECT_ATTEMPT_RESERVATION) break;
      if (
        candidate.attachedAt !== null ||
        candidate.expiresAt.getTime() > now.getTime()
      ) {
        continue;
      }
      const result = await this.cleanupBatch(
        candidate,
        now,
        BATCH_OBJECT_ATTEMPT_RESERVATION - batchAttempts,
      );
      completed += result.completed;
      failures += result.failures;
      batchAttempts += result.completed + result.failures;
    }
    const projectCandidates = await this.prisma.$queryRaw<
      readonly ProjectCleanupCandidate[]
    >`
      SELECT "id", "workspaceId", "projectId", "importBatchId", "status",
             "objectKey", "createdAt", "cleanupStartedAt", "cleanupLastAttemptAt"
      FROM "MediaAsset"
      WHERE "projectId" IS NOT NULL
        AND (
          "status" = 'DELETING'
          OR (
            "status" = 'PENDING'
            AND "createdAt" <= ${new Date(now.getTime() - PENDING_PROJECT_UPLOAD_TTL_MS)}
          )
        )
      ORDER BY COALESCE(
        "cleanupLastAttemptAt",
        CASE
          WHEN "status" = 'PENDING'
            THEN "createdAt" + INTERVAL '24 hours'
          ELSE "deletionMarkedAt"
        END
      ), "id"
      LIMIT ${CLEANUP_OBJECT_ATTEMPT_LIMIT}
    `;
    for (const candidate of projectCandidates) {
      if (completed + failures >= CLEANUP_OBJECT_ATTEMPT_LIMIT) break;
      const result = await this.cleanupProjectAsset(candidate, now);
      completed += result.completed;
      failures += result.failures;
    }
    if (failures > 0) {
      throw new Error(`Media cleanup failed for ${failures} object(s)`);
    }
    return completed;
  }

  private async cleanupProjectAsset(
    candidate: ProjectCleanupCandidate,
    now: Date,
  ): Promise<CleanupResult> {
    const cutoff = new Date(now.getTime() - PENDING_PROJECT_UPLOAD_TTL_MS);
    const claimed = await this.claimProjectAsset(candidate, cutoff, now);
    if (claimed === null) return { completed: 0, failures: 0 };
    const key = restorePersistedMediaObjectKey({
      key: claimed.objectKey,
      workspaceId: claimed.workspaceId,
      assetId: claimed.id,
      owner:
        claimed.importBatchId === null
          ? { kind: 'project', projectId: claimed.projectId }
          : { kind: 'import', batchId: claimed.importBatchId },
    });
    try {
      await this.storage.delete(key);
      return { completed: 1, failures: 0 };
    } catch {
      return { completed: 0, failures: 1 };
    }
  }

  private claimProjectAsset(
    candidate: ProjectCleanupCandidate,
    cutoff: Date,
    now: Date,
  ): Promise<ProjectCleanupCandidate | null> {
    return this.transactions.run(async (context) =>
      this.transactions[PrismaTransactionClientService](
        context,
        async (client) => {
          const transaction = client as CleanupPrismaClient;
          const locked = await transaction.$queryRaw<
            readonly ProjectCleanupCandidate[]
          >`
            SELECT "id", "workspaceId", "projectId", "importBatchId", "status",
                   "objectKey", "createdAt", "cleanupStartedAt", "cleanupLastAttemptAt"
            FROM "MediaAsset"
            WHERE "id" = ${candidate.id}::uuid
              AND "workspaceId" = ${candidate.workspaceId}::uuid
              AND "projectId" = ${candidate.projectId}::uuid
              AND (
                "status" = 'DELETING'
                OR ("status" = 'PENDING' AND "createdAt" <= ${cutoff})
              )
            FOR UPDATE
          `;
          const asset = locked[0];
          if (asset === undefined) return null;
          const claimed = await transaction.$executeRaw`
            UPDATE "MediaAsset"
            SET "cleanupStartedAt" = COALESCE("cleanupStartedAt", ${now}),
                "cleanupLastAttemptAt" = ${now}
            WHERE "id" = ${asset.id}::uuid
              AND "workspaceId" = ${asset.workspaceId}::uuid
          `;
          if (claimed !== 1) return null;
          return asset;
        },
      ),
    );
  }

  private async cleanupBatch(
    candidate: ExpiredBatchCandidate,
    now: Date,
    maximumAttempts: number,
  ): Promise<CleanupResult> {
    const claimed = await this.claimBatch(candidate, now);
    if (claimed === null) return { completed: 0, failures: 0 };
    const assets = await this.prisma.$queryRaw<readonly CleanupAssetRow[]>`
      SELECT "id", "objectKey", "cleanupLastAttemptAt"
      FROM "MediaAsset"
      WHERE "workspaceId" = ${claimed.workspaceId}::uuid
        AND "importBatchId" = ${claimed.id}::uuid
        AND "projectId" IS NULL
      ORDER BY COALESCE("cleanupLastAttemptAt", "createdAt"), "id"
      LIMIT ${maximumAttempts}
    `;
    let completed = 0;
    let failures = 0;
    for (const asset of assets) {
      await this.prisma.$executeRaw`
        UPDATE "MediaAsset"
        SET "cleanupLastAttemptAt" = ${now}
        WHERE "id" = ${asset.id}::uuid
          AND "workspaceId" = ${claimed.workspaceId}::uuid
          AND "importBatchId" = ${claimed.id}::uuid
          AND "projectId" IS NULL
      `;
      const key = restorePersistedMediaObjectKey({
        key: asset.objectKey,
        workspaceId: claimed.workspaceId,
        assetId: asset.id,
        owner: { kind: 'import', batchId: claimed.id },
      });
      try {
        await this.storage.delete(key);
        completed += 1;
      } catch {
        failures += 1;
      }
    }
    return { completed, failures };
  }

  private claimBatch(
    candidate: ExpiredBatchCandidate,
    now: Date,
  ): Promise<ExpiredBatchCandidate | null> {
    return this.transactions.run(async (context) =>
      this.transactions[PrismaTransactionClientService](
        context,
        async (client) => {
          const transaction = client as CleanupPrismaClient;
          const locked = await transaction.$queryRaw<
            readonly (ExpiredBatchCandidate & {
              readonly cleanupStartedAt: Date | null;
            })[]
          >`
            SELECT "id", "workspaceId", "expiresAt", "attachedAt",
                   "cleanupStartedAt", "cleanupLastAttemptAt"
            FROM "MediaImportBatch"
            WHERE "id" = ${candidate.id}::uuid
              AND "workspaceId" = ${candidate.workspaceId}::uuid
              AND "attachedAt" IS NULL
              AND "expiresAt" <= ${now}
            FOR UPDATE
          `;
          const batch = locked[0];
          if (batch === undefined) return null;
          const claimed = await transaction.$executeRaw`
            UPDATE "MediaImportBatch"
            SET "cleanupStartedAt" = COALESCE("cleanupStartedAt", ${now}),
                "cleanupLastAttemptAt" = ${now}
            WHERE "id" = ${batch.id}::uuid
              AND "workspaceId" = ${batch.workspaceId}::uuid
          `;
          if (claimed !== 1) return null;
          return batch;
        },
      ),
    );
  }
}
