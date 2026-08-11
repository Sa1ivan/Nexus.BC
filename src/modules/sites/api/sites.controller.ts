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
  Res,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  APP_CONFIG,
  type AppConfig,
} from '../../../shared/config/app-config.schema';
import { createApiHttpException } from '../../../shared/http/api-error.filter';
import {
  requireEditorPageInput,
  requireExpectedDraftVersion,
  requireIdempotencyKey,
  requireProjectName,
  requireUuidPath,
  requireValidClientCapabilities,
} from '../../../shared/http/editor-request-contract';
import {
  exactRequestBody,
  requireAllowedOrigin,
} from '../../../shared/http/request-contract';
import { ensureResponseRequestId } from '../../../shared/http/request-id.middleware';
import {
  AUTHENTICATED_PRINCIPAL,
  type AuthenticatedPrincipal,
} from '../../auth/application/public';
import { CreateProject } from '../application/create-project';
import { ActivateRelease } from '../application/activate-release';
import { GetProject } from '../application/get-project';
import { ListProjectRevisions } from '../application/list-project-revisions';
import { ListProjectSummaries } from '../application/list-project-summaries';
import { SaveProjectDraft } from '../application/save-project-draft';
import { PublishProject } from '../application/publish-project';
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
    private readonly publishProject: PublishProject,
    private readonly activateRelease: ActivateRelease,
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
    const expectedDraftVersion = requireExpectedDraftVersion(
      input['expectedDraftVersion'],
    );
    return this.saveProjectDraft.execute({
      workspaceId,
      projectId,
      userId: actor.userId,
      operationId,
      expectedDraftVersion,
      siteConfig: input['siteConfig'],
    });
  }

  @Post(':projectId/publish')
  @HttpCode(200)
  async publish(
    @Param('workspaceId') workspaceId: string,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
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
    const expectedDraftVersion = requireExpectedDraftVersion(
      input['expectedDraftVersion'],
    );
    return this.publishProject.execute({
      workspaceId,
      projectId,
      userId: actor.userId,
      operationId,
      requestId: ensureResponseRequestId(response),
      expectedDraftVersion,
      siteConfig: input['siteConfig'],
    });
  }

  @Post(':projectId/releases/:releaseId/activate')
  @HttpCode(200)
  async activate(
    @Param('workspaceId') workspaceId: string,
    @Param('projectId') projectId: string,
    @Param('releaseId') releaseId: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
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
    requireUuidPath(releaseId);
    requireValidClientCapabilities(request);
    requireAllowedOrigin(request, this.configuration.webOrigins);
    const operationId = requireIdempotencyKey(request);
    return this.activateRelease.execute({
      workspaceId,
      projectId,
      releaseId,
      userId: actor.userId,
      operationId,
      requestId: ensureResponseRequestId(response),
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
