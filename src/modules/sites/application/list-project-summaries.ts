import { Inject, Injectable } from '@nestjs/common';
import {
  APP_CONFIG,
  type AppConfig,
} from '../../../shared/config/app-config.schema';
import type { CursorPageDto, ProjectSummaryDto } from './public';
import { SiteAccessPolicy } from './site-access-policy';
import { projectSummaryDto } from './site-project-view';
import { InvalidSiteCursorError, SitesApplicationError } from './sites-errors';
import {
  SITE_REPOSITORY,
  type CursorInput,
  type CursorPage,
  type ProjectSummary,
  type SiteRepository,
} from './sites.ports';

@Injectable()
export class ListProjectSummaries {
  constructor(
    @Inject(SITE_REPOSITORY) private readonly repository: SiteRepository,
    private readonly access: SiteAccessPolicy,
    @Inject(APP_CONFIG) private readonly configuration: AppConfig,
  ) {}

  async execute(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly page?: CursorInput;
  }): Promise<CursorPageDto<ProjectSummaryDto>> {
    await this.access.requireMember(input.workspaceId, input.userId);
    let page: CursorPage<ProjectSummary>;
    try {
      page = await this.repository.listProjectSummaries(
        input.workspaceId,
        input.page,
      );
    } catch (error) {
      if (error instanceof InvalidSiteCursorError) {
        throw new SitesApplicationError('VALIDATION_ERROR');
      }
      throw error;
    }
    return {
      items: page.items.map((summary) =>
        projectSummaryDto(summary, this.configuration),
      ),
      nextCursor: page.nextCursor,
    };
  }
}
