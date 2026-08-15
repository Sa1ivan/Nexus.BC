import {
  Controller,
  Body,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
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
  requireUuidPath,
  requireValidClientCapabilities,
} from '../../../shared/http/editor-request-contract';
import { requireMediaUploadRequest } from '../../../shared/http/media-request-contract';
import {
  exactRequestBody,
  requireAllowedOrigin,
} from '../../../shared/http/request-contract';
import { ensureResponseRequestId } from '../../../shared/http/request-id.middleware';
import {
  AUTHENTICATED_PRINCIPAL,
  type AuthenticatedPrincipal,
} from '../../auth/application/public';
import {
  DELETE_MEDIA_ASSET,
  DeleteMediaAsset,
} from '../application/delete-media-asset';
import { CreateMediaUpload } from '../application/create-media-upload';
import { CompleteManagedMediaUpload } from '../application/complete-managed-media-upload';
import { ListProjectMedia } from '../application/list-project-media';
import { MediaApplicationErrorInterceptor } from './media-application-error.interceptor';

type AuthenticatedRequest = Request & {
  [AUTHENTICATED_PRINCIPAL]?: AuthenticatedPrincipal;
};

@UseInterceptors(MediaApplicationErrorInterceptor)
@Controller('v1/workspaces/:workspaceId/projects/:projectId/media')
export class MediaController {
  constructor(
    @Inject(DELETE_MEDIA_ASSET)
    private readonly deleteMediaAsset: DeleteMediaAsset,
    private readonly createMediaUpload: CreateMediaUpload,
    private readonly completeMediaUpload: CompleteManagedMediaUpload,
    private readonly listProjectMedia: ListProjectMedia,
    @Inject(APP_CONFIG) private readonly configuration: AppConfig,
  ) {}

  @Post('uploads')
  @HttpCode(201)
  async createUpload(
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
    const input = exactRequestBody(body, [
      'fileName',
      'mimeType',
      'sizeBytes',
      'checksumSha256',
    ]);
    const declaration = requireMediaUploadRequest({
      fileName: input['fileName'],
      mimeType: input['mimeType'],
      sizeBytes: input['sizeBytes'],
      checksumSha256: input['checksumSha256'],
    });
    return this.createMediaUpload.forProject({
      workspaceId,
      projectId,
      actorUserId: actor.userId,
      declaration,
    });
  }

  @Post(':assetId/complete')
  @HttpCode(200)
  async complete(
    @Param('workspaceId') workspaceId: string,
    @Param('projectId') projectId: string,
    @Param('assetId') assetId: string,
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
    requireUuidPath(assetId);
    requireValidClientCapabilities(request);
    requireAllowedOrigin(request, this.configuration.webOrigins);
    return this.completeMediaUpload.execute({
      workspaceId,
      assetId,
      owner: { kind: 'project', projectId },
      actorUserId: actor.userId,
      requestId: ensureResponseRequestId(response),
    });
  }

  @Get()
  async list(
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
    return this.listProjectMedia.execute({
      workspaceId,
      projectId,
      actorUserId: actor.userId,
    });
  }

  @Delete(':assetId')
  async delete(
    @Param('workspaceId') workspaceId: string,
    @Param('projectId') projectId: string,
    @Param('assetId') assetId: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
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
    requireUuidPath(assetId);
    requireValidClientCapabilities(request);
    requireAllowedOrigin(request, this.configuration.webOrigins);
    const result = await this.deleteMediaAsset.execute({
      workspaceId,
      projectId,
      assetId,
      actorUserId: actor.userId,
      requestId: ensureResponseRequestId(response),
    });
    response.status(result.kind === 'pending' ? 202 : 204);
  }
}
