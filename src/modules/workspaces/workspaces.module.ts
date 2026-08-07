import { Global, Module } from '@nestjs/common';
import { WorkspaceApplicationErrorInterceptor } from './api/workspace-application-error.interceptor';
import { WorkspacesController } from './api/workspaces.controller';
import { ChangeMembershipRole } from './application/change-membership-role';
import { CreateWorkspace } from './application/create-workspace';
import { GetWorkspace } from './application/get-workspace';
import { WORKSPACE_ACCESS } from './application/public';
import { WORKSPACE_REPOSITORY } from './application/workspace.ports';
import { PrismaWorkspaceRepository } from './infrastructure/prisma-workspace.repository';

@Global()
@Module({
  controllers: [WorkspacesController],
  providers: [
    PrismaWorkspaceRepository,
    { provide: WORKSPACE_REPOSITORY, useExisting: PrismaWorkspaceRepository },
    { provide: WORKSPACE_ACCESS, useExisting: PrismaWorkspaceRepository },
    CreateWorkspace,
    GetWorkspace,
    ChangeMembershipRole,
    WorkspaceApplicationErrorInterceptor,
  ],
  exports: [WORKSPACE_ACCESS],
})
export class WorkspacesModule {}
