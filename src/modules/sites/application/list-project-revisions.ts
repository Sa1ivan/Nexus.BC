import { Inject, Injectable } from '@nestjs/common';
import type { ProjectRevision } from '../domain/project-revision';
import type { CursorPageDto, ProjectRevisionMetadataDto } from './public';
import { SiteAccessPolicy } from './site-access-policy';
import { projectRevisionMetadataDto } from './site-project-view';
import { InvalidSiteCursorError, SitesApplicationError } from './sites-errors';
import {
  SITE_REPOSITORY,
  type CursorInput,
  type CursorPage,
  type SiteRepository,
} from './sites.ports';

@Injectable()
export class ListProjectRevisions {
  constructor(
    @Inject(SITE_REPOSITORY) private readonly repository: SiteRepository,
    private readonly access: SiteAccessPolicy,
  ) {}

  async execute(input: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly userId: string;
    readonly page?: CursorInput;
  }): Promise<CursorPageDto<ProjectRevisionMetadataDto>> {
    await this.access.requireMember(input.workspaceId, input.userId);
    const project = await this.repository.findForWorkspace(
      input.workspaceId,
      input.projectId,
    );
    if (project === null) throw new SitesApplicationError('NOT_FOUND');
    let page: CursorPage<ProjectRevision>;
    try {
      page = await this.repository.listRevisions(
        input.workspaceId,
        input.projectId,
        input.page,
      );
    } catch (error) {
      if (error instanceof InvalidSiteCursorError) {
        throw new SitesApplicationError('VALIDATION_ERROR');
      }
      throw error;
    }
    return {
      items: page.items.map(projectRevisionMetadataDto),
      nextCursor: page.nextCursor,
    };
  }
}
