import { Global, Module } from '@nestjs/common';
import { SITE_CONFIG_ROLLOUT_READINESS } from '../../shared/health/site-config-rollout-readiness';
import { SitesApplicationErrorInterceptor } from './api/sites-application-error.interceptor';
import { SitesController } from './api/sites.controller';
import { PublicSitesController } from './api/public-sites.controller';
import { ActivateRelease } from './application/activate-release';
import { CreateProject } from './application/create-project';
import { GetProject } from './application/get-project';
import { GetPublicSite } from './application/get-public-site';
import { ListProjectRevisions } from './application/list-project-revisions';
import { ListProjectSummaries } from './application/list-project-summaries';
import { PUBLISH_PROJECT, PublishProject } from './application/publish-project';
import {
  SAVE_PROJECT_DRAFT,
  SaveProjectDraft,
} from './application/save-project-draft';
import { SiteAccessPolicy } from './application/site-access-policy';
import { SitesProjectTransactionLock } from './application/sites-project-transaction-lock';
import { SITES_RETAINED_MEDIA_REFERENCE } from './application/public';
import { SITE_REPOSITORY } from './application/sites.ports';
import { PrismaSiteRepository } from './infrastructure/prisma-site.repository';
import { SiteConfigRolloutGuard } from './infrastructure/site-config-rollout-guard';

@Global()
@Module({
  controllers: [SitesController, PublicSitesController],
  providers: [
    PrismaSiteRepository,
    SiteConfigRolloutGuard,
    { provide: SITE_REPOSITORY, useExisting: PrismaSiteRepository },
    {
      provide: SITES_RETAINED_MEDIA_REFERENCE,
      useExisting: PrismaSiteRepository,
    },
    {
      provide: SITE_CONFIG_ROLLOUT_READINESS,
      useExisting: SiteConfigRolloutGuard,
    },
    SiteAccessPolicy,
    SitesProjectTransactionLock,
    CreateProject,
    GetProject,
    GetPublicSite,
    SaveProjectDraft,
    { provide: SAVE_PROJECT_DRAFT, useExisting: SaveProjectDraft },
    ListProjectSummaries,
    ListProjectRevisions,
    PublishProject,
    { provide: PUBLISH_PROJECT, useExisting: PublishProject },
    ActivateRelease,
    SitesApplicationErrorInterceptor,
  ],
  exports: [
    SITE_REPOSITORY,
    SITE_CONFIG_ROLLOUT_READINESS,
    SITES_RETAINED_MEDIA_REFERENCE,
  ],
})
export class SitesModule {}
