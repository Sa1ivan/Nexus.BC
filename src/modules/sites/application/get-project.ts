import { Inject, Injectable } from '@nestjs/common';
import {
  APP_CONFIG,
  type AppConfig,
} from '../../../shared/config/app-config.schema';
import type { EditorProjectDto } from './public';
import { SiteAccessPolicy } from './site-access-policy';
import { editorProjectDto } from './site-project-view';
import { SitesApplicationError } from './sites-errors';
import { SITE_REPOSITORY, type SiteRepository } from './sites.ports';

@Injectable()
export class GetProject {
  constructor(
    @Inject(SITE_REPOSITORY) private readonly repository: SiteRepository,
    private readonly access: SiteAccessPolicy,
    @Inject(APP_CONFIG) private readonly configuration: AppConfig,
  ) {}

  async execute(input: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly userId: string;
  }): Promise<EditorProjectDto> {
    await this.access.requireMember(input.workspaceId, input.userId);
    const project = await this.repository.findForWorkspace(
      input.workspaceId,
      input.projectId,
    );
    if (project === null) throw new SitesApplicationError('NOT_FOUND');
    return editorProjectDto(project, this.configuration);
  }
}
