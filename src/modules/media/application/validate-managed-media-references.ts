import { Inject, Injectable } from '@nestjs/common';
import {
  type TransactionContext,
  TransactionRunner,
} from '../../../shared/database/transaction-runner';
import { MEDIA_MAX_BYTES } from '../domain/media-asset';
import type {
  MediaManagedReferenceValidation,
  ValidateManagedMediaReferencesInput,
  ValidateManagedMediaReferencesResult,
} from './public';
import { MEDIA_INSPECTOR, type MediaInspector } from './ports/media-inspector';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
  restorePersistedMediaObjectKey,
} from './ports/object-storage';
import { verifyMediaContent } from './verify-media-content';

interface LockedManagedMediaRow {
  readonly id: string;
  readonly importBatchId: string | null;
  readonly status: string;
  readonly objectKey: string;
  readonly declaredFileName: string;
  readonly declaredMimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  readonly declaredSizeBytes: number;
  readonly declaredChecksumSha256: string;
  readonly verifiedMimeType: string | null;
  readonly verifiedSizeBytes: number | null;
  readonly verifiedWidth: number | null;
  readonly verifiedHeight: number | null;
  readonly verifiedChecksumSha256: string | null;
  readonly verifiedAt: Date | null;
  readonly deletionMarkedAt: Date | null;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

@Injectable()
export class ValidateManagedMediaReferences implements MediaManagedReferenceValidation {
  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MEDIA_INSPECTOR) private readonly inspector: MediaInspector,
    private readonly transactions: TransactionRunner,
  ) {}

  async validate(
    context: TransactionContext,
    input: ValidateManagedMediaReferencesInput,
  ): Promise<ValidateManagedMediaReferencesResult> {
    const referencedAssetIds = [...new Set(input.referencedAssetIds)].sort(
      (left, right) => left.localeCompare(right),
    );
    if (referencedAssetIds.length === 0) return { kind: 'ready' };
    if (referencedAssetIds.some((assetId) => !uuidPattern.test(assetId))) {
      return { kind: 'not-ready' };
    }
    const assets = await this.transactions.queryRawUnsafe<
      LockedManagedMediaRow[]
    >(
      context,
      `SELECT asset.*
         FROM "MediaAsset" asset
        WHERE asset."id" = ANY($1::uuid[])
          AND asset."workspaceId" = $2::uuid
          AND asset."projectId" = $3::uuid
        ORDER BY asset."id" FOR UPDATE`,
      referencedAssetIds,
      input.workspaceId,
      input.projectId,
    );
    if (assets.length !== referencedAssetIds.length) {
      return { kind: 'not-ready' };
    }

    for (const asset of assets) {
      if (
        asset.status !== 'READY' ||
        asset.verifiedMimeType === null ||
        asset.verifiedSizeBytes === null ||
        asset.verifiedWidth === null ||
        asset.verifiedHeight === null ||
        asset.verifiedChecksumSha256 === null ||
        asset.verifiedAt === null ||
        asset.deletionMarkedAt !== null
      ) {
        return { kind: 'not-ready' };
      }
      let key;
      try {
        key = restorePersistedMediaObjectKey({
          key: asset.objectKey,
          workspaceId: input.workspaceId,
          assetId: asset.id,
          owner:
            asset.importBatchId === null
              ? { kind: 'project', projectId: input.projectId }
              : { kind: 'import', batchId: asset.importBatchId },
        });
      } catch {
        return { kind: 'not-ready' };
      }
      const stored = await this.storage.readBounded({
        key,
        maxBytes: MEDIA_MAX_BYTES,
      });
      if (
        stored.kind !== 'found' ||
        stored.metadata.contentLength > MEDIA_MAX_BYTES
      ) {
        return { kind: 'not-ready' };
      }
      const inspected = await verifyMediaContent(
        {
          declaration: {
            fileName: asset.declaredFileName,
            mimeType: asset.declaredMimeType,
            sizeBytes: asset.declaredSizeBytes,
            checksumSha256: asset.declaredChecksumSha256,
          },
          body: stored.body,
        },
        this.inspector,
      );
      if (
        !inspected.ok ||
        inspected.value.mimeType !== asset.verifiedMimeType ||
        inspected.value.sizeBytes !== asset.verifiedSizeBytes ||
        inspected.value.width !== asset.verifiedWidth ||
        inspected.value.height !== asset.verifiedHeight ||
        inspected.value.checksumSha256 !== asset.verifiedChecksumSha256
      ) {
        return { kind: 'not-ready' };
      }
    }
    return { kind: 'ready' };
  }
}
