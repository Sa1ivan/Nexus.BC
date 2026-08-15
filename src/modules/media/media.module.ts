import { Global, Module } from '@nestjs/common';
import { MediaController } from './api/media.controller';
import { MediaImportController } from './api/media-import.controller';
import { MediaApplicationErrorInterceptor } from './api/media-application-error.interceptor';
import { CompleteMediaUpload } from './application/complete-media-upload';
import { CompleteManagedMediaUpload } from './application/complete-managed-media-upload';
import { CreateMediaImportBatch } from './application/create-media-import-batch';
import { CreateMediaUpload } from './application/create-media-upload';
import {
  DELETE_MEDIA_ASSET,
  DeleteMediaAsset,
} from './application/delete-media-asset';
import { MediaAccessPolicy } from './application/media-access-policy';
import { MediaProjectTransactionLock } from './application/media-project-transaction-lock';
import { ListProjectMedia } from './application/list-project-media';
import { PublicMediaDelivery } from './application/public-media-delivery';
import {
  MEDIA_IMPORT_ATTACHMENT,
  MEDIA_MANAGED_REFERENCE_VALIDATION,
  MEDIA_PUBLIC_DELIVERY,
} from './application/public';
import { MEDIA_INSPECTOR } from './application/ports/media-inspector';
import {
  MEDIA_CATALOG_REPOSITORY,
  MEDIA_REPOSITORY,
} from './application/ports/media-repository';
import { OBJECT_STORAGE } from './application/ports/object-storage';
import { ValidateManagedMediaReferences } from './application/validate-managed-media-references';
import { PrismaMediaRepository } from './infrastructure/prisma-media.repository';
import { CleanupExpiredMediaImports } from './infrastructure/cleanup-expired-media-imports';
import { MediaCleanupWorker } from './infrastructure/media-cleanup.worker';
import { R2ObjectStorage } from './infrastructure/r2-object-storage';
import { SharpMediaInspector } from './infrastructure/sharp-media-inspector';

@Global()
@Module({
  controllers: [MediaController, MediaImportController],
  providers: [
    PrismaMediaRepository,
    CleanupExpiredMediaImports,
    MediaCleanupWorker,
    SharpMediaInspector,
    R2ObjectStorage,
    ValidateManagedMediaReferences,
    PublicMediaDelivery,
    { provide: MEDIA_REPOSITORY, useExisting: PrismaMediaRepository },
    { provide: MEDIA_CATALOG_REPOSITORY, useExisting: PrismaMediaRepository },
    { provide: MEDIA_IMPORT_ATTACHMENT, useExisting: PrismaMediaRepository },
    {
      provide: MEDIA_MANAGED_REFERENCE_VALIDATION,
      useExisting: ValidateManagedMediaReferences,
    },
    { provide: MEDIA_PUBLIC_DELIVERY, useExisting: PublicMediaDelivery },
    { provide: MEDIA_INSPECTOR, useExisting: SharpMediaInspector },
    { provide: OBJECT_STORAGE, useExisting: R2ObjectStorage },
    CompleteMediaUpload,
    CompleteManagedMediaUpload,
    CreateMediaUpload,
    CreateMediaImportBatch,
    ListProjectMedia,
    DeleteMediaAsset,
    { provide: DELETE_MEDIA_ASSET, useExisting: DeleteMediaAsset },
    MediaAccessPolicy,
    MediaProjectTransactionLock,
    MediaApplicationErrorInterceptor,
  ],
  exports: [
    MEDIA_IMPORT_ATTACHMENT,
    MEDIA_MANAGED_REFERENCE_VALIDATION,
    MEDIA_PUBLIC_DELIVERY,
  ],
})
export class MediaModule {}
