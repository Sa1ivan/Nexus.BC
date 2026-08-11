import { Inject, Injectable } from '@nestjs/common';
import { PrismaClientService } from '../../../shared/database/prisma.service';
import type { TransactionContext } from '../../../shared/database/transaction-runner';
import {
  PrismaTransactionClientService,
  TransactionRunner,
} from '../../../shared/database/transaction-runner';
import type {
  AttachMediaImportBatchInput,
  AttachMediaImportBatchResult,
  MediaImportAttachment,
} from '../application/public';
import type {
  FindMediaCompletionTargetInput,
  MarkMediaReadyInput,
  MarkMediaReadyResult,
  MediaCompletionTarget,
  MediaRepository,
} from '../application/ports/media-repository';
import type { MediaObjectOwner } from '../application/ports/object-storage';
import type {
  MediaAsset,
  MediaAssetStatus,
  MediaMimeType,
  MediaVerification,
} from '../domain/media-asset';

interface ImportBatchSummaryRow {
  readonly expiresAt: Date;
  readonly attachedAt: Date | null;
}

interface VerificationFields {
  readonly verifiedMimeType: string | null;
  readonly verifiedSizeBytes: number | null;
  readonly verifiedWidth: number | null;
  readonly verifiedHeight: number | null;
  readonly verifiedChecksumSha256: string | null;
  readonly verifiedAt: Date | null;
}

interface MediaAssetRow extends VerificationFields {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly importBatchId: string | null;
  readonly status: string;
  readonly objectKey: string;
  readonly declaredFileName: string;
  readonly declaredMimeType: string;
  readonly declaredSizeBytes: number;
  readonly declaredChecksumSha256: string;
  readonly deletionMarkedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly importBatch: ImportBatchSummaryRow | null;
}

interface MediaPrismaClient {
  readonly mediaAsset: {
    findFirst(
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<MediaAssetRow | null>;
  };
}

interface AttachmentBatchRow {
  readonly attachedProjectId: string | null;
  readonly attachedAt: Date | null;
  readonly expiresAt: Date;
}

interface AttachmentAssetRow {
  readonly id: string;
  readonly status: string;
  readonly projectId: string | null;
}

interface MediaTransactionClient {
  $executeRaw(
    query: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<number>;
  $queryRaw<T>(
    query: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<T>;
  readonly project: {
    findFirst(
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<{ readonly id: string } | null>;
  };
  readonly mediaAsset: {
    updateMany(
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<{ readonly count: number }>;
    findFirst(arguments_: Readonly<Record<string, unknown>>): Promise<
      | (VerificationFields & {
          readonly status: string;
          readonly importBatch: ImportBatchSummaryRow | null;
        })
      | null
    >;
  };
}

function mediaMimeType(value: string): MediaMimeType {
  if (
    value === 'image/jpeg' ||
    value === 'image/png' ||
    value === 'image/webp'
  ) {
    return value;
  }
  throw new Error('Stored media MIME type is invalid');
}

function mediaStatus(value: string): MediaAssetStatus {
  if (value === 'PENDING' || value === 'READY' || value === 'DELETING') {
    return value;
  }
  throw new Error('Stored media status is invalid');
}

function storedVerification(row: VerificationFields): MediaVerification | null {
  const {
    verifiedMimeType,
    verifiedSizeBytes,
    verifiedWidth,
    verifiedHeight,
    verifiedChecksumSha256,
    verifiedAt,
  } = row;
  if (
    verifiedMimeType === null &&
    verifiedSizeBytes === null &&
    verifiedWidth === null &&
    verifiedHeight === null &&
    verifiedChecksumSha256 === null &&
    verifiedAt === null
  ) {
    return null;
  }
  if (
    verifiedMimeType === null ||
    verifiedSizeBytes === null ||
    verifiedWidth === null ||
    verifiedHeight === null ||
    verifiedChecksumSha256 === null ||
    verifiedAt === null
  ) {
    throw new Error('Stored media verification is incomplete');
  }
  return {
    mimeType: mediaMimeType(verifiedMimeType),
    sizeBytes: verifiedSizeBytes,
    width: verifiedWidth,
    height: verifiedHeight,
    checksumSha256: verifiedChecksumSha256,
    verifiedAt,
  };
}

function storedAsset(row: MediaAssetRow): MediaAsset {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    importBatchId: row.importBatchId,
    status: mediaStatus(row.status),
    objectKey: row.objectKey,
    declaration: {
      fileName: row.declaredFileName,
      mimeType: mediaMimeType(row.declaredMimeType),
      sizeBytes: row.declaredSizeBytes,
      checksumSha256: row.declaredChecksumSha256,
    },
    verification: storedVerification(row),
    deletionMarkedAt: row.deletionMarkedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function ownerWhere(
  owner: MediaObjectOwner,
): Readonly<Record<string, unknown>> {
  return owner.kind === 'project'
    ? { projectId: owner.projectId }
    : { importBatchId: owner.batchId, projectId: null };
}

function exactAssetSet(
  referencedAssetIds: readonly string[],
  assets: readonly AttachmentAssetRow[],
): boolean {
  const referenced = new Set(referencedAssetIds);
  if (
    referenced.size !== referencedAssetIds.length ||
    referenced.size !== assets.length
  ) {
    return false;
  }
  return assets.every(({ id }) => referenced.has(id));
}

@Injectable()
export class PrismaMediaRepository
  implements MediaRepository, MediaImportAttachment
{
  constructor(
    @Inject(PrismaClientService)
    private readonly prisma: MediaPrismaClient,
    private readonly transactions: TransactionRunner,
  ) {}

  async findCompletionTarget(
    input: FindMediaCompletionTargetInput,
  ): Promise<MediaCompletionTarget | null> {
    const row = await this.prisma.mediaAsset.findFirst({
      where: {
        id: input.assetId,
        workspaceId: input.workspaceId,
        ...ownerWhere(input.owner),
      },
      include: {
        importBatch: {
          select: { expiresAt: true, attachedAt: true },
        },
      },
    });
    if (row === null) return null;
    return {
      asset: storedAsset(row),
      importBatch: row.importBatch,
    };
  }

  async markReady(
    context: TransactionContext,
    input: MarkMediaReadyInput,
  ): Promise<MarkMediaReadyResult> {
    return this.transactions[PrismaTransactionClientService](
      context,
      async (client) => {
        const transaction = client as MediaTransactionClient;
        const transitionAt = new Date();
        const eligibleOwner =
          input.owner.kind === 'import'
            ? {
                ...ownerWhere(input.owner),
                importBatch: {
                  is: {
                    attachedAt: null,
                    expiresAt: { gt: transitionAt },
                  },
                },
              }
            : ownerWhere(input.owner);
        const updated = await transaction.mediaAsset.updateMany({
          where: {
            id: input.assetId,
            workspaceId: input.workspaceId,
            status: 'PENDING',
            ...eligibleOwner,
          },
          data: {
            status: 'READY',
            verifiedMimeType: input.verification.mimeType,
            verifiedSizeBytes: input.verification.sizeBytes,
            verifiedWidth: input.verification.width,
            verifiedHeight: input.verification.height,
            verifiedChecksumSha256: input.verification.checksumSha256,
            verifiedAt: input.verification.verifiedAt,
          },
        });
        if (updated.count === 1) return { kind: 'updated' };

        const current = await transaction.mediaAsset.findFirst({
          where: {
            id: input.assetId,
            workspaceId: input.workspaceId,
            ...ownerWhere(input.owner),
          },
          select: {
            status: true,
            verifiedMimeType: true,
            verifiedSizeBytes: true,
            verifiedWidth: true,
            verifiedHeight: true,
            verifiedChecksumSha256: true,
            verifiedAt: true,
            importBatch: {
              select: { expiresAt: true, attachedAt: true },
            },
          },
        });
        if (current === null) return { kind: 'not-found' };
        if (current.status === 'READY') {
          const verification = storedVerification(current);
          if (verification === null) {
            throw new Error('Stored READY media asset has no verification');
          }
          return { kind: 'already-ready', verification };
        }
        if (
          input.owner.kind === 'import' &&
          current.importBatch !== null &&
          current.importBatch.expiresAt.getTime() <= transitionAt.getTime()
        ) {
          return { kind: 'expired' };
        }
        return { kind: 'not-pending' };
      },
    );
  }

  async attach(
    context: TransactionContext,
    input: AttachMediaImportBatchInput,
  ): Promise<AttachMediaImportBatchResult> {
    return this.transactions[PrismaTransactionClientService](
      context,
      async (client) =>
        this.attachInTransaction(client as MediaTransactionClient, input),
    );
  }

  private async attachInTransaction(
    transaction: MediaTransactionClient,
    input: AttachMediaImportBatchInput,
  ): Promise<AttachMediaImportBatchResult> {
    const batches = await transaction.$queryRaw<AttachmentBatchRow[]>`
      SELECT "attachedProjectId", "attachedAt", "expiresAt"
      FROM "MediaImportBatch"
      WHERE "workspaceId" = ${input.workspaceId}::uuid
        AND "id" = ${input.batchId}::uuid
      FOR UPDATE
    `;
    const batch = batches[0];
    if (batch === undefined) return { kind: 'not-found' };
    if (batch.attachedAt !== null || batch.attachedProjectId !== null) {
      return { kind: 'already-attached' };
    }
    if (batch.expiresAt.getTime() <= Date.now()) {
      return { kind: 'expired' };
    }

    const project = await transaction.project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      select: { id: true },
    });
    if (project === null) return { kind: 'not-found' };

    const assets = await transaction.$queryRaw<AttachmentAssetRow[]>`
      SELECT "id", "status", "projectId"
      FROM "MediaAsset"
      WHERE "workspaceId" = ${input.workspaceId}::uuid
        AND "importBatchId" = ${input.batchId}::uuid
      ORDER BY "id"
      FOR UPDATE
    `;
    if (!exactAssetSet(input.referencedAssetIds, assets)) {
      return { kind: 'asset-set-mismatch' };
    }
    if (
      assets.some(
        ({ status, projectId }) => status !== 'READY' || projectId !== null,
      )
    ) {
      return { kind: 'asset-not-ready' };
    }

    const batchUpdateCount = await transaction.$executeRaw`
      UPDATE "MediaImportBatch"
      SET "attachedProjectId" = ${input.projectId}::uuid,
          "attachedAt" = clock_timestamp()
      WHERE "id" = ${input.batchId}::uuid
        AND "workspaceId" = ${input.workspaceId}::uuid
        AND "attachedProjectId" IS NULL
        AND "attachedAt" IS NULL
        AND "expiresAt" > clock_timestamp()
    `;
    if (batchUpdateCount !== 1) return { kind: 'expired' };

    const assetUpdate = await transaction.mediaAsset.updateMany({
      where: {
        workspaceId: input.workspaceId,
        importBatchId: input.batchId,
        id: { in: input.referencedAssetIds },
        status: 'READY',
        projectId: null,
      },
      data: { projectId: input.projectId },
    });
    if (assetUpdate.count !== assets.length) {
      throw new Error('Media import attachment lost its locked state');
    }
    return { kind: 'attached' };
  }
}
