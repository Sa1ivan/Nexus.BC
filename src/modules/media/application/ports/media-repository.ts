import type { TransactionContext } from '../../../../shared/database/transaction-runner';
import type { MediaAsset, MediaVerification } from '../../domain/media-asset';
import type { MediaImportBatch } from '../../domain/media-import-batch';
import type { MediaObjectOwner } from './object-storage';

export const MEDIA_REPOSITORY = Symbol('MediaRepository');
export const MEDIA_CATALOG_REPOSITORY = Symbol('MediaCatalogRepository');

export interface MediaCompletionTarget {
  readonly asset: MediaAsset;
  readonly importBatch: {
    readonly expiresAt: Date;
    readonly attachedAt: Date | null;
    readonly cleanupStartedAt: Date | null;
  } | null;
}

export interface FindMediaCompletionTargetInput {
  readonly workspaceId: string;
  readonly assetId: string;
  readonly owner: MediaObjectOwner;
}

export interface MarkMediaReadyInput extends FindMediaCompletionTargetInput {
  readonly verification: MediaVerification;
}

export interface LockProjectMediaAssetsInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly referencedAssetIds: readonly string[];
}

export interface LockProjectMediaAssetInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly assetId: string;
}

export type MarkMediaReadyResult =
  | { readonly kind: 'updated' }
  | {
      readonly kind: 'already-ready';
      readonly verification: MediaVerification;
    }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'not-pending' };

export interface MediaRepository {
  findCompletionTarget(
    input: FindMediaCompletionTargetInput,
  ): Promise<MediaCompletionTarget | null>;
  markReady(
    context: TransactionContext,
    input: MarkMediaReadyInput,
  ): Promise<MarkMediaReadyResult>;
}

export interface CreateMediaAssetInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly importBatchId: string | null;
  readonly objectKey: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
}

export interface CreateMediaImportBatchInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface MediaCatalogRepository {
  projectExists(workspaceId: string, projectId: string): Promise<boolean>;
  createAsset(input: CreateMediaAssetInput): Promise<MediaAsset | null>;
  removePendingAsset(workspaceId: string, assetId: string): Promise<void>;
  listProjectAssets(
    workspaceId: string,
    projectId: string,
  ): Promise<readonly MediaAsset[]>;
  createImportBatch(
    input: CreateMediaImportBatchInput,
  ): Promise<MediaImportBatch>;
  findOpenImportBatch(
    workspaceId: string,
    batchId: string,
    now: Date,
  ): Promise<MediaImportBatch | null>;
  findReadyProjectAssets(
    workspaceId: string,
    projectId: string,
    assetIds: readonly string[],
  ): Promise<readonly MediaAsset[]>;
  lockProjectAsset(
    context: TransactionContext,
    input: LockProjectMediaAssetInput,
  ): Promise<MediaAsset | null>;
  markDeleting(
    context: TransactionContext,
    input: LockProjectMediaAssetInput,
  ): Promise<boolean>;
}
