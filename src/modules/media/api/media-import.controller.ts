import {
  Body,
  Controller,
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
import { CompleteManagedMediaUpload } from '../application/complete-managed-media-upload';
import { CreateMediaImportBatch } from '../application/create-media-import-batch';
import { CreateMediaUpload } from '../application/create-media-upload';
import { MediaApplicationErrorInterceptor } from './media-application-error.interceptor';

type AuthenticatedRequest = Request & {
  [AUTHENTICATED_PRINCIPAL]?: AuthenticatedPrincipal;
};

@UseInterceptors(MediaApplicationErrorInterceptor)
@Controller('v1/workspaces/:workspaceId/media/import-batches')
export class MediaImportController {
  constructor(
    private readonly createBatch: CreateMediaImportBatch,
    private readonly createUpload: CreateMediaUpload,
    private readonly completeUpload: CompleteManagedMediaUpload,
    @Inject(APP_CONFIG) private readonly configuration: AppConfig,
  ) {}

  @Post()
  @HttpCode(201)
  create(
    @Param('workspaceId') workspaceId: string,
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
    return this.createBatch.execute({
      workspaceId,
      actorUserId: actor.userId,
    });
  }

  @Post(':batchId/uploads')
  @HttpCode(201)
  createUploadGrant(
    @Param('workspaceId') workspaceId: string,
    @Param('batchId') batchId: string,
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
    requireUuidPath(batchId);
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
    return this.createUpload.forImport({
      workspaceId,
      batchId,
      actorUserId: actor.userId,
      declaration,
    });
  }

  @Post(':batchId/media/:assetId/complete')
  @HttpCode(200)
  complete(
    @Param('workspaceId') workspaceId: string,
    @Param('batchId') batchId: string,
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
    requireUuidPath(batchId);
    requireUuidPath(assetId);
    requireValidClientCapabilities(request);
    requireAllowedOrigin(request, this.configuration.webOrigins);
    return this.completeUpload.execute({
      workspaceId,
      assetId,
      owner: { kind: 'import', batchId },
      actorUserId: actor.userId,
      requestId: ensureResponseRequestId(response),
    });
  }
}
