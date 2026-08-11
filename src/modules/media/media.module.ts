import { Module } from '@nestjs/common';
import { MEDIA_IMPORT_ATTACHMENT } from './application/public';
import { MEDIA_INSPECTOR } from './application/ports/media-inspector';
import { MEDIA_REPOSITORY } from './application/ports/media-repository';
import { PrismaMediaRepository } from './infrastructure/prisma-media.repository';
import { SharpMediaInspector } from './infrastructure/sharp-media-inspector';

@Module({
  providers: [
    PrismaMediaRepository,
    SharpMediaInspector,
    { provide: MEDIA_REPOSITORY, useExisting: PrismaMediaRepository },
    { provide: MEDIA_IMPORT_ATTACHMENT, useExisting: PrismaMediaRepository },
    { provide: MEDIA_INSPECTOR, useExisting: SharpMediaInspector },
  ],
  exports: [MEDIA_IMPORT_ATTACHMENT],
})
export class MediaModule {}
