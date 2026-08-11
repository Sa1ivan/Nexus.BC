import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AUDIT_WRITER,
  type AuditWriter,
} from '../../../shared/audit/audit-writer';
import { TransactionRunner } from '../../../shared/database/transaction-runner';
import {
  MEDIA_MAX_BYTES,
  type MediaVerification,
  type MediaVerificationResult,
} from '../domain/media-asset';
import { MEDIA_INSPECTOR, type MediaInspector } from './ports/media-inspector';
import {
  MEDIA_REPOSITORY,
  type MediaRepository,
} from './ports/media-repository';
import {
  OBJECT_STORAGE,
  type MediaObjectOwner,
  type ObjectStorage,
  restorePersistedMediaObjectKey,
} from './ports/object-storage';
import { verifyMediaContent } from './verify-media-content';

type VerificationFailureCode = Extract<
  MediaVerificationResult,
  { readonly ok: false }
>['code'];

export type CompleteMediaUploadResult =
  | {
      readonly kind: 'ready';
      readonly transition: 'completed' | 'already-ready';
      readonly verification: MediaVerification;
    }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'storage-object-not-found' }
  | { readonly kind: 'state-conflict' }
  | { readonly kind: 'rejected'; readonly code: VerificationFailureCode };

@Injectable()
export class CompleteMediaUpload {
  constructor(
    @Inject(MEDIA_REPOSITORY) private readonly repository: MediaRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MEDIA_INSPECTOR) private readonly inspector: MediaInspector,
    private readonly transactions: TransactionRunner,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  async execute(input: {
    readonly workspaceId: string;
    readonly assetId: string;
    readonly owner: MediaObjectOwner;
    readonly actorUserId: string;
    readonly requestId: string;
  }): Promise<CompleteMediaUploadResult> {
    const target = await this.repository.findCompletionTarget(input);
    if (target === null) return { kind: 'not-found' };

    const importBatch =
      input.owner.kind === 'import' ? target.importBatch : null;
    if (input.owner.kind === 'import' && importBatch === null) {
      throw new Error('Stored import media asset has no import batch');
    }

    const key = restorePersistedMediaObjectKey({
      key: target.asset.objectKey,
      workspaceId: input.workspaceId,
      assetId: input.assetId,
      owner: input.owner,
    });

    if (target.asset.status === 'READY') {
      if (target.asset.verification === null) {
        throw new Error('Stored READY media asset has no verification');
      }
      return {
        kind: 'ready',
        transition: 'already-ready',
        verification: target.asset.verification,
      };
    }
    if (importBatch !== null) {
      if (importBatch.attachedAt !== null) {
        return { kind: 'state-conflict' };
      }
      if (importBatch.expiresAt.getTime() <= Date.now()) {
        return { kind: 'expired' };
      }
    }
    if (target.asset.status !== 'PENDING') {
      return { kind: 'state-conflict' };
    }

    const stored = await this.storage.readBounded({
      key,
      maxBytes: MEDIA_MAX_BYTES,
    });
    if (stored.kind === 'not-found') {
      return { kind: 'storage-object-not-found' };
    }
    if (
      stored.kind === 'too-large' ||
      stored.metadata.contentLength > MEDIA_MAX_BYTES
    ) {
      return { kind: 'rejected', code: 'media-too-large' };
    }

    const result = await verifyMediaContent(
      {
        declaration: target.asset.declaration,
        body: stored.body,
      },
      this.inspector,
    );
    if (!result.ok) return { kind: 'rejected', code: result.code };

    const verification: MediaVerification = {
      ...result.value,
      verifiedAt: new Date(),
    };
    return this.transactions.run(async (context) => {
      const transition = await this.repository.markReady(context, {
        workspaceId: input.workspaceId,
        assetId: input.assetId,
        owner: input.owner,
        verification,
      });
      if (transition.kind === 'not-found') return { kind: 'not-found' };
      if (transition.kind === 'expired') return { kind: 'expired' };
      if (transition.kind === 'not-pending') {
        return { kind: 'state-conflict' };
      }
      if (transition.kind === 'already-ready') {
        return {
          kind: 'ready',
          transition: 'already-ready',
          verification: transition.verification,
        };
      }
      if (transition.kind === 'updated') {
        await this.audit.append(context, {
          eventId: randomUUID(),
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          action: 'MEDIA_VERIFIED',
          resourceType: 'MediaAsset',
          resourceId: input.assetId,
          metadata: { outcome: 'ready' },
          requestId: input.requestId,
        });
      }
      return {
        kind: 'ready',
        transition: 'completed',
        verification,
      };
    });
  }
}
