import { Inject, Injectable } from '@nestjs/common';
import { WorkspaceApplicationError } from './workspace-errors';
import {
  WORKSPACE_REPOSITORY,
  type WorkspaceRepository,
  type WorkspaceView,
} from './workspace.ports';

@Injectable()
export class GetWorkspace {
  constructor(
    @Inject(WORKSPACE_REPOSITORY)
    private readonly repository: WorkspaceRepository,
  ) {}

  async execute(workspaceId: string, userId: string): Promise<WorkspaceView> {
    const workspace = await this.repository.findForUser(workspaceId, userId);
    if (workspace === null) {
      throw new WorkspaceApplicationError('NOT_FOUND');
    }
    return workspace;
  }
}
