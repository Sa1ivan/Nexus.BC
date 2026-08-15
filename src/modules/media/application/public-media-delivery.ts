import { Inject, Injectable } from '@nestjs/common';
import type {
  MediaPublicDelivery,
  PublicManagedMediaReference,
} from './public';
import {
  MEDIA_CATALOG_REPOSITORY,
  type MediaCatalogRepository,
} from './ports/media-repository';
import {
  OBJECT_STORAGE,
  OBJECT_STORAGE_PRESIGNED_GET_TTL_SECONDS,
  type ObjectStorage,
  restorePersistedMediaObjectKey,
} from './ports/object-storage';

@Injectable()
export class PublicMediaDelivery implements MediaPublicDelivery {
  constructor(
    @Inject(MEDIA_CATALOG_REPOSITORY)
    private readonly repository: MediaCatalogRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async resolveProjectAssets(input: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly assetIds: readonly string[];
  }): Promise<readonly PublicManagedMediaReference[] | null> {
    const assetIds = [...new Set(input.assetIds)].sort((left, right) =>
      left.localeCompare(right),
    );
    const assets = await this.repository.findReadyProjectAssets(
      input.workspaceId,
      input.projectId,
      assetIds,
    );
    if (
      assets.length !== assetIds.length ||
      assets.some((asset) => asset.verification === null)
    ) {
      return null;
    }
    return Promise.all(
      assets.map(async (asset) => {
        const key = restorePersistedMediaObjectKey({
          key: asset.objectKey,
          workspaceId: asset.workspaceId,
          assetId: asset.id,
          owner:
            asset.importBatchId === null
              ? { kind: 'project', projectId: input.projectId }
              : { kind: 'import', batchId: asset.importBatchId },
        });
        const delivery = await this.storage.createPresignedGet({
          key,
          expiresInSeconds: OBJECT_STORAGE_PRESIGNED_GET_TTL_SECONDS,
        });
        return { assetId: asset.id, deliveryUrl: delivery.url };
      }),
    );
  }
}
