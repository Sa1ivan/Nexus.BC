import type { TransactionContext } from '../../../shared/database/transaction-runner';

export const MEDIA_IMPORT_ATTACHMENT = Symbol('MediaImportAttachment');

export interface AttachMediaImportBatchInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly batchId: string;
  readonly referencedAssetIds: readonly string[];
}

export type AttachMediaImportBatchResult =
  | { readonly kind: 'attached' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'already-attached' }
  | { readonly kind: 'asset-set-mismatch' }
  | { readonly kind: 'asset-not-ready' };

export interface MediaImportAttachment {
  attach(
    context: TransactionContext,
    input: AttachMediaImportBatchInput,
  ): Promise<AttachMediaImportBatchResult>;
}
