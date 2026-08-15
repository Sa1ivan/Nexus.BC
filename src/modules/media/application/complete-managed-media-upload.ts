import { Injectable } from '@nestjs/common';
import type { MediaObjectOwner } from './ports/object-storage';
import { CompleteMediaUpload } from './complete-media-upload';
import { MediaAccessPolicy } from './media-access-policy';
import { MediaApplicationError } from './media-errors';

@Injectable()
export class CompleteManagedMediaUpload {
  constructor(
    private readonly completion: CompleteMediaUpload,
    private readonly access: MediaAccessPolicy,
  ) {}

  async execute(input: {
    readonly workspaceId: string;
    readonly assetId: string;
    readonly owner: MediaObjectOwner;
    readonly actorUserId: string;
    readonly requestId: string;
  }) {
    await this.access.requireMember(input.workspaceId, input.actorUserId);
    const result = await this.completion.execute(input);
    if (result.kind === 'not-found') {
      throw new MediaApplicationError('NOT_FOUND');
    }
    if (result.kind === 'expired') {
      throw new MediaApplicationError('MEDIA_UPLOAD_EXPIRED');
    }
    if (
      result.kind === 'state-conflict' ||
      result.kind === 'storage-object-not-found'
    ) {
      throw new MediaApplicationError('MEDIA_ASSET_NOT_READY');
    }
    if (result.kind === 'rejected') {
      throw new MediaApplicationError('MEDIA_CONTENT_REJECTED');
    }
    return {
      assetId: input.assetId,
      status: 'READY' as const,
      mimeType: result.verification.mimeType,
      sizeBytes: result.verification.sizeBytes,
      width: result.verification.width,
      height: result.verification.height,
      checksumSha256: result.verification.checksumSha256,
      verifiedAt: result.verification.verifiedAt.toISOString(),
    };
  }
}
