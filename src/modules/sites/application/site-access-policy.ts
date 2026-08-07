import { Inject, Injectable } from '@nestjs/common';
import {
  WORKSPACE_ACCESS,
  type WorkspaceAccess,
} from '../../workspaces/application/public';
import { SitesApplicationError } from './sites-errors';

@Injectable()
export class SiteAccessPolicy {
  constructor(
    @Inject(WORKSPACE_ACCESS)
    private readonly workspaces: WorkspaceAccess,
  ) {}

  async requireMember(workspaceId: string, userId: string): Promise<void> {
    const workspace = await this.workspaces.findForUser(workspaceId, userId);
    if (workspace === null) throw new SitesApplicationError('NOT_FOUND');
  }
}
