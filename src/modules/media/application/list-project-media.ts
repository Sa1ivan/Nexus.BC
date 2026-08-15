import { Inject, Injectable } from '@nestjs/common';
import { MediaAccessPolicy } from './media-access-policy';
import { MediaApplicationError } from './media-errors';
import {
  MEDIA_CATALOG_REPOSITORY,
  type MediaCatalogRepository,
} from './ports/media-repository';

@Injectable()
export class ListProjectMedia {
  constructor(
    @Inject(MEDIA_CATALOG_REPOSITORY)
    private readonly repository: MediaCatalogRepository,
    private readonly access: MediaAccessPolicy,
  ) {}

  async execute(input: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly actorUserId: string;
  }) {
    await this.access.requireMember(input.workspaceId, input.actorUserId);
    if (
      !(await this.repository.projectExists(input.workspaceId, input.projectId))
    ) {
      throw new MediaApplicationError('NOT_FOUND');
    }
    const assets = await this.repository.listProjectAssets(
      input.workspaceId,
      input.projectId,
    );
    return {
      items: assets.map((asset) => ({
        assetId: asset.id,
        status: asset.status,
        fileName: asset.declaration.fileName,
        mimeType: asset.declaration.mimeType,
        sizeBytes: asset.declaration.sizeBytes,
        width: asset.verification?.width ?? null,
        height: asset.verification?.height ?? null,
        createdAt: asset.createdAt.toISOString(),
      })),
    };
  }
}
