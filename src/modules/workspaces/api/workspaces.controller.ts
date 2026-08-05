import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  AUTHENTICATED_PRINCIPAL,
  type AuthenticatedPrincipal,
} from '../../auth/application/public';
import { createApiHttpException } from '../../../shared/http/api-error.filter';
import {
  exactRequestBody,
  requireString,
  throwRequestValidationError,
} from '../../../shared/http/request-contract';
import { ensureResponseRequestId } from '../../../shared/http/request-id.middleware';
import { ChangeMembershipRole } from '../application/change-membership-role';
import { CreateWorkspace } from '../application/create-workspace';
import { GetWorkspace } from '../application/get-workspace';
import type { WorkspaceRole } from '../application/workspace.ports';
import { WorkspaceApplicationErrorInterceptor } from './workspace-application-error.interceptor';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type AuthenticatedRequest = Request & {
  [AUTHENTICATED_PRINCIPAL]?: AuthenticatedPrincipal;
};

@UseInterceptors(WorkspaceApplicationErrorInterceptor)
@Controller('v1/workspaces')
export class WorkspacesController {
  constructor(
    private readonly createWorkspace: CreateWorkspace,
    private readonly getWorkspace: GetWorkspace,
    private readonly changeMembershipRole: ChangeMembershipRole,
  ) {}

  @Post()
  async create(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const principal = request[AUTHENTICATED_PRINCIPAL];
    if (principal === undefined) {
      throw createApiHttpException(
        401,
        'AUTHENTICATION_REQUIRED',
        'Authentication required',
      );
    }
    const input = exactRequestBody(body, ['name']);
    const name = requireString(input['name']).trim().normalize('NFC');
    if (name.length === 0 || name.length > 120) {
      throwRequestValidationError();
    }
    return this.createWorkspace.execute(principal.userId, name);
  }

  @Get(':workspaceId')
  async get(
    @Param('workspaceId') workspaceId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const principal = request[AUTHENTICATED_PRINCIPAL];
    if (principal === undefined) {
      throw createApiHttpException(
        401,
        'AUTHENTICATION_REQUIRED',
        'Authentication required',
      );
    }
    if (!uuidPattern.test(workspaceId)) {
      throw createApiHttpException(404, 'NOT_FOUND', 'Resource not found');
    }
    return this.getWorkspace.execute(workspaceId, principal.userId);
  }

  @Patch(':workspaceId/members/:userId/role')
  @HttpCode(200)
  async changeRole(
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const principal = request[AUTHENTICATED_PRINCIPAL];
    if (principal === undefined) {
      throw createApiHttpException(
        401,
        'AUTHENTICATION_REQUIRED',
        'Authentication required',
      );
    }
    if (!uuidPattern.test(workspaceId) || !uuidPattern.test(userId)) {
      throw createApiHttpException(404, 'NOT_FOUND', 'Resource not found');
    }
    const input = exactRequestBody(body, ['role']);
    const role = input['role'];
    if (role !== 'OWNER' && role !== 'EDITOR') {
      throwRequestValidationError();
    }
    return this.changeMembershipRole.execute({
      workspaceId,
      targetUserId: userId,
      actorUserId: principal.userId,
      role: role satisfies WorkspaceRole,
      requestId: ensureResponseRequestId(response),
    });
  }
}
