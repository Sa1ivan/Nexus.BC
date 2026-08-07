import { Module } from '@nestjs/common';
import { SITE_REPOSITORY } from './application/sites.ports';
import { PrismaSiteRepository } from './infrastructure/prisma-site.repository';

@Module({
  providers: [
    PrismaSiteRepository,
    { provide: SITE_REPOSITORY, useExisting: PrismaSiteRepository },
  ],
  exports: [SITE_REPOSITORY],
})
export class SitesModule {}
