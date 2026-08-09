import { Module } from '@nestjs/common';
import { SitesApplicationErrorInterceptor } from './api/sites-application-error.interceptor';
import { SitesController } from './api/sites.controller';
import { PublicSitesController } from './api/public-sites.controller';
import { ActivateRelease } from './application/activate-release';
import { CreateProject } from './application/create-project';
import { GetProject } from './application/get-project';
import { GetPublicSite } from './application/get-public-site';
import { ListProjectRevisions } from './application/list-project-revisions';
import { ListProjectSummaries } from './application/list-project-summaries';
import { PublishProject } from './application/publish-project';
import { SaveProjectDraft } from './application/save-project-draft';
import { SiteAccessPolicy } from './application/site-access-policy';
import { SITE_REPOSITORY } from './application/sites.ports';
import { PrismaSiteRepository } from './infrastructure/prisma-site.repository';

@Module({
  controllers: [SitesController, PublicSitesController],
  providers: [
    PrismaSiteRepository,
    { provide: SITE_REPOSITORY, useExisting: PrismaSiteRepository },
    SiteAccessPolicy,
    CreateProject,
    GetProject,
    GetPublicSite,
    SaveProjectDraft,
    ListProjectSummaries,
    ListProjectRevisions,
    PublishProject,
    ActivateRelease,
    SitesApplicationErrorInterceptor,
  ],
  exports: [SITE_REPOSITORY],
})
export class SitesModule {}
