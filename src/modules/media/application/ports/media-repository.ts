import type { TransactionContext } from '../../../../shared/database/transaction-runner';
import type { MediaAsset, MediaVerification } from '../../domain/media-asset';
import type { MediaObjectOwner } from './object-storage';

export const MEDIA_REPOSITORY = Symbol('MediaRepository');

export interface MediaCompletionTarget {
  readonly asset: MediaAsset;
  readonly importBatch: {
    readonly expiresAt: Date;
    readonly attachedAt: Date | null;
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
