import type { TransactionContext } from '../../../shared/database/transaction-runner';

export const MEDIA_IMPORT_ATTACHMENT = Symbol('MediaImportAttachment');
export const MEDIA_MANAGED_REFERENCE_VALIDATION = Symbol(
  'MediaManagedReferenceValidation',
);
export const MEDIA_PUBLIC_DELIVERY = Symbol('MediaPublicDelivery');

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

export interface ValidateManagedMediaReferencesInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly referencedAssetIds: readonly string[];
}

export type ValidateManagedMediaReferencesResult =
  { readonly kind: 'ready' } | { readonly kind: 'not-ready' };

export interface MediaManagedReferenceValidation {
  validate(
    context: TransactionContext,
    input: ValidateManagedMediaReferencesInput,
  ): Promise<ValidateManagedMediaReferencesResult>;
}

export interface PublicManagedMediaReference {
  readonly assetId: string;
  readonly deliveryUrl: string;
}

export interface MediaPublicDelivery {
  resolveProjectAssets(input: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly assetIds: readonly string[];
  }): Promise<readonly PublicManagedMediaReference[] | null>;
}
