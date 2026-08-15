import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { MediaMimeType } from '../domain/media-asset';
import { MediaAccessPolicy } from './media-access-policy';
import { MediaApplicationError } from './media-errors';
import {
  MEDIA_CATALOG_REPOSITORY,
  type MediaCatalogRepository,
} from './ports/media-repository';
import {
  OBJECT_STORAGE,
  OBJECT_STORAGE_CREATE_ONLY_WRITE_CONDITION,
  OBJECT_STORAGE_PRESIGNED_PUT_TTL_SECONDS,
  type MediaObjectOwner,
  type ObjectStorage,
  buildImportMediaObjectKey,
  buildProjectMediaObjectKey,
} from './ports/object-storage';

export interface MediaUploadDeclaration {
  readonly fileName: string;
  readonly mimeType: MediaMimeType;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
}

export interface MediaUploadGrantDto {
  readonly assetId: string;
  readonly status: 'PENDING';
  readonly upload: {
    readonly url: string;
    readonly method: 'PUT';
    readonly requiredHeaders: Readonly<Record<string, string>>;
    readonly expiresAt: string;
  };
}

@Injectable()
export class CreateMediaUpload {
  constructor(
    @Inject(MEDIA_CATALOG_REPOSITORY)
    private readonly repository: MediaCatalogRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly access: MediaAccessPolicy,
  ) {}

  async forProject(input: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly actorUserId: string;
    readonly declaration: MediaUploadDeclaration;
  }): Promise<MediaUploadGrantDto> {
    await this.access.requireMember(input.workspaceId, input.actorUserId);
    if (
      !(await this.repository.projectExists(input.workspaceId, input.projectId))
    ) {
      throw new MediaApplicationError('NOT_FOUND');
    }
    return this.issue({
      ...input,
      owner: { kind: 'project', projectId: input.projectId },
    });
  }

  async forImport(input: {
    readonly workspaceId: string;
    readonly batchId: string;
    readonly actorUserId: string;
    readonly declaration: MediaUploadDeclaration;
  }): Promise<MediaUploadGrantDto> {
    await this.access.requireMember(input.workspaceId, input.actorUserId);
    if (
      (await this.repository.findOpenImportBatch(
        input.workspaceId,
        input.batchId,
        new Date(),
      )) === null
    ) {
      throw new MediaApplicationError('NOT_FOUND');
    }
    return this.issue({
      ...input,
      owner: { kind: 'import', batchId: input.batchId },
    });
  }

  private async issue(input: {
    readonly workspaceId: string;
    readonly actorUserId: string;
    readonly declaration: MediaUploadDeclaration;
    readonly owner: MediaObjectOwner;
  }): Promise<MediaUploadGrantDto> {
    const assetId = randomUUID();
    const key =
      input.owner.kind === 'project'
        ? buildProjectMediaObjectKey({
            workspaceId: input.workspaceId,
            projectId: input.owner.projectId,
            assetId,
            safeName: input.declaration.fileName,
          })
        : buildImportMediaObjectKey({
            workspaceId: input.workspaceId,
            batchId: input.owner.batchId,
            assetId,
            safeName: input.declaration.fileName,
          });
    const asset = await this.repository.createAsset({
      id: assetId,
      workspaceId: input.workspaceId,
      projectId: input.owner.kind === 'project' ? input.owner.projectId : null,
      importBatchId: input.owner.kind === 'import' ? input.owner.batchId : null,
      objectKey: key,
      fileName: input.declaration.fileName,
      mimeType: input.declaration.mimeType,
      sizeBytes: input.declaration.sizeBytes,
      checksumSha256: input.declaration.checksumSha256,
    });
    if (asset === null) throw new MediaApplicationError('NOT_FOUND');
    try {
      const upload = await this.storage.createPresignedPut({
        key,
        contentLength: input.declaration.sizeBytes,
        contentType: input.declaration.mimeType,
        expiresInSeconds: OBJECT_STORAGE_PRESIGNED_PUT_TTL_SECONDS,
        writeCondition: OBJECT_STORAGE_CREATE_ONLY_WRITE_CONDITION,
      });
      return {
        assetId,
        status: 'PENDING',
        upload: {
          ...upload,
          expiresAt: upload.expiresAt.toISOString(),
        },
      };
    } catch (error) {
      await this.repository.removePendingAsset(input.workspaceId, assetId);
      throw error;
    }
  }
}
