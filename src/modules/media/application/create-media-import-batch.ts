import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { MediaAccessPolicy } from './media-access-policy';
import {
  MEDIA_CATALOG_REPOSITORY,
  type MediaCatalogRepository,
} from './ports/media-repository';

const IMPORT_BATCH_TTL_MS = 24 * 60 * 60 * 1_000;

@Injectable()
export class CreateMediaImportBatch {
  constructor(
    @Inject(MEDIA_CATALOG_REPOSITORY)
    private readonly repository: MediaCatalogRepository,
    private readonly access: MediaAccessPolicy,
  ) {}

  async execute(input: {
    readonly workspaceId: string;
    readonly actorUserId: string;
  }): Promise<{ readonly batchId: string; readonly expiresAt: string }> {
    await this.access.requireMember(input.workspaceId, input.actorUserId);
    const createdAt = new Date();
    const batch = await this.repository.createImportBatch({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + IMPORT_BATCH_TTL_MS),
    });
    return { batchId: batch.id, expiresAt: batch.expiresAt.toISOString() };
  }
}
