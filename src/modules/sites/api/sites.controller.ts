import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  APP_CONFIG,
  type AppConfig,
} from '../../../shared/config/app-config.schema';
import { createApiHttpException } from '../../../shared/http/api-error.filter';
import {
  requireEditorPageInput,
  requireIdempotencyKey,
  requireProjectName,
  requireUuidPath,
  requireValidClientCapabilities,
} from '../../../shared/http/editor-request-contract';
import {
  exactRequestBody,
  requireAllowedOrigin,
  throwRequestValidationError,
} from '../../../shared/http/request-contract';
import {
  AUTHENTICATED_PRINCIPAL,
  type AuthenticatedPrincipal,
} from '../../auth/application/public';
import { CreateProject } from '../application/create-project';
import { GetProject } from '../application/get-project';
import { ListProjectRevisions } from '../application/list-project-revisions';
import { ListProjectSummaries } from '../application/list-project-summaries';
import { SaveProjectDraft } from '../application/save-project-draft';
import { SitesApplicationErrorInterceptor } from './sites-application-error.interceptor';

type AuthenticatedRequest = Request & {
  [AUTHENTICATED_PRINCIPAL]?: AuthenticatedPrincipal;
};

@UseInterceptors(SitesApplicationErrorInterceptor)
@Controller('v1/workspaces/:workspaceId/projects')
export class SitesController {
  constructor(
    private readonly createProject: CreateProject,
    private readonly getProject: GetProject,
    private readonly saveProjectDraft: SaveProjectDraft,
    private readonly listProjectSummaries: ListProjectSummaries,
    private readonly listProjectRevisions: ListProjectRevisions,
    @Inject(APP_CONFIG) private readonly configuration: AppConfig,
  ) {}

  @Post()
  @HttpCode(201)
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const actor = request[AUTHENTICATED_PRINCIPAL];
    if (actor === undefined) {
      throw createApiHttpException(
        401,
        'AUTHENTICATION_REQUIRED',
        'Authentication required',
      );
    }
    requireUuidPath(workspaceId);
    requireValidClientCapabilities(request);
    requireAllowedOrigin(request, this.configuration.webOrigins);
    const operationId = requireIdempotencyKey(request);
    const input = exactRequestBody(body, ['name', 'siteConfig']);
    return this.createProject.execute({
      workspaceId,
      userId: actor.userId,
      operationId,
      name: requireProjectName(input['name']),
      siteConfig: input['siteConfig'],
    });
  }

  @Get()
  async list(
    @Param('workspaceId') workspaceId: string,
    @Query() query: Readonly<Record<string, unknown>>,
    @Req() request: AuthenticatedRequest,
  ) {
    const actor = request[AUTHENTICATED_PRINCIPAL];
    if (actor === undefined) {
      throw createApiHttpException(
        401,
        'AUTHENTICATION_REQUIRED',
        'Authentication required',
      );
    }
    requireUuidPath(workspaceId);
    requireValidClientCapabilities(request);
    return this.listProjectSummaries.execute({
      workspaceId,
      userId: actor.userId,
      page: requireEditorPageInput(query),
    });
  }

  @Get(':projectId')
  async get(
    @Param('workspaceId') workspaceId: string,
    @Param('projectId') projectId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const actor = request[AUTHENTICATED_PRINCIPAL];
    if (actor === undefined) {
      throw createApiHttpException(
        401,
        'AUTHENTICATION_REQUIRED',
        'Authentication required',
      );
    }
    requireUuidPath(workspaceId);
    requireUuidPath(projectId);
    requireValidClientCapabilities(request);
    return this.getProject.execute({
      workspaceId,
      projectId,
      userId: actor.userId,
    });
  }

  @Put(':projectId/draft')
  @HttpCode(200)
  async saveDraft(
    @Param('workspaceId') workspaceId: string,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const actor = request[AUTHENTICATED_PRINCIPAL];
    if (actor === undefined) {
      throw createApiHttpException(
        401,
        'AUTHENTICATION_REQUIRED',
        'Authentication required',
      );
    }
    requireUuidPath(workspaceId);
    requireUuidPath(projectId);
    requireValidClientCapabilities(request);
    requireAllowedOrigin(request, this.configuration.webOrigins);
    const operationId = requireIdempotencyKey(request);
    const input = exactRequestBody(body, [
      'expectedDraftVersion',
      'siteConfig',
    ]);
    const expectedDraftVersion = input['expectedDraftVersion'];
    if (
      !Number.isSafeInteger(expectedDraftVersion) ||
      Number(expectedDraftVersion) < 1
    ) {
      throwRequestValidationError();
    }
    return this.saveProjectDraft.execute({
      workspaceId,
      projectId,
      userId: actor.userId,
      operationId,
      expectedDraftVersion: Number(expectedDraftVersion),
      siteConfig: input['siteConfig'],
    });
  }

  @Get(':projectId/revisions')
  async revisions(
    @Param('workspaceId') workspaceId: string,
    @Param('projectId') projectId: string,
    @Query() query: Readonly<Record<string, unknown>>,
    @Req() request: AuthenticatedRequest,
  ) {
    const actor = request[AUTHENTICATED_PRINCIPAL];
    if (actor === undefined) {
      throw createApiHttpException(
        401,
        'AUTHENTICATION_REQUIRED',
        'Authentication required',
      );
    }
    requireUuidPath(workspaceId);
    requireUuidPath(projectId);
    requireValidClientCapabilities(request);
    return this.listProjectRevisions.execute({
      workspaceId,
      projectId,
      userId: actor.userId,
      page: requireEditorPageInput(query),
    });
  }
}
