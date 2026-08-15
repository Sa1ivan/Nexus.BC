import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AUDIT_WRITER,
  type AuditWriter,
} from '../../../shared/audit/audit-writer';
import { TransactionRunner } from '../../../shared/database/transaction-runner';
import {
  SITES_RETAINED_MEDIA_REFERENCE,
  type SitesRetainedMediaReference,
} from '../../sites/application/public';
import { MediaAccessPolicy } from './media-access-policy';
import { MediaApplicationError } from './media-errors';
import { MediaProjectTransactionLock } from './media-project-transaction-lock';
import {
  MEDIA_CATALOG_REPOSITORY,
  type MediaCatalogRepository,
} from './ports/media-repository';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
  restorePersistedMediaObjectKey,
} from './ports/object-storage';

type DeleteOutcome =
  | {
      readonly kind: 'deleting';
      readonly objectKey: string;
      readonly importBatchId: string | null;
    }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'in-use' };

export type DeleteMediaAssetResult =
  { readonly kind: 'pending' } | { readonly kind: 'purged' };

export const DELETE_MEDIA_ASSET = Symbol('DeleteMediaAsset');

@Injectable()
export class DeleteMediaAsset {
  constructor(
    @Inject(MEDIA_CATALOG_REPOSITORY)
    private readonly repository: MediaCatalogRepository,
    @Inject(SITES_RETAINED_MEDIA_REFERENCE)
    private readonly sites: SitesRetainedMediaReference,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly transactions: TransactionRunner,
    private readonly projectLock: MediaProjectTransactionLock,
    private readonly access: MediaAccessPolicy,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  async execute(input: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly assetId: string;
    readonly actorUserId: string;
    readonly requestId: string;
  }): Promise<DeleteMediaAssetResult> {
    await this.access.requireMember(input.workspaceId, input.actorUserId);
    const outcome = await this.transactions.run<DeleteOutcome>(
      async (context) => {
        await this.projectLock.acquire(context, input.projectId);
        const asset = await this.repository.lockProjectAsset(context, input);
        if (asset === null || asset.status === 'PENDING') {
          return { kind: 'not-found' };
        }
        if (asset.status === 'DELETING') {
          if (asset.deletionMarkedAt === null) {
            throw new Error('Stored DELETING media asset has no marker');
          }
          return {
            kind: 'deleting',
            objectKey: asset.objectKey,
            importBatchId: asset.importBatchId,
          };
        }
        const inUse = await this.sites.hasRetainedReference(context, input);
        if (inUse) return { kind: 'in-use' };
        const marked = await this.markMediaAssetDeleting(context, input);
        if (!marked) return { kind: 'not-found' };
        await this.audit.append(context, {
          eventId: randomUUID(),
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          action: 'MEDIA_DELETION_MARKED',
          resourceType: 'MediaAsset',
          resourceId: input.assetId,
          metadata: { outcome: 'deleting' },
          requestId: input.requestId,
        });
        return {
          kind: 'deleting',
          objectKey: asset.objectKey,
          importBatchId: asset.importBatchId,
        };
      },
    );
    if (outcome.kind === 'not-found') {
      throw new MediaApplicationError('NOT_FOUND');
    }
    if (outcome.kind === 'in-use') {
      throw new MediaApplicationError('MEDIA_ASSET_IN_USE');
    }
    const key = restorePersistedMediaObjectKey({
      key: outcome.objectKey,
      workspaceId: input.workspaceId,
      assetId: input.assetId,
      owner:
        outcome.importBatchId === null
          ? { kind: 'project', projectId: input.projectId }
          : { kind: 'import', batchId: outcome.importBatchId },
    });
    try {
      await this.storage.delete(key);
      return { kind: 'purged' };
    } catch {
      return { kind: 'pending' };
    }
  }

  private markMediaAssetDeleting(
    context: Parameters<MediaCatalogRepository['markDeleting']>[0],
    input: Parameters<MediaCatalogRepository['markDeleting']>[1],
  ): ReturnType<MediaCatalogRepository['markDeleting']> {
    return this.repository.markDeleting(context, input);
  }
}
