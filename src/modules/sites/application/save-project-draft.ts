import { Inject, Injectable } from '@nestjs/common';
import {
  APP_CONFIG,
  type AppConfig,
} from '../../../shared/config/app-config.schema';
import { IdempotencyCoordinator } from '../../../shared/idempotency/idempotency-coordinator';
import {
  MEDIA_MANAGED_REFERENCE_VALIDATION,
  type MediaManagedReferenceValidation,
} from '../../media/application/public';
import { managedMediaAssetIds } from './managed-media-references';
import type { EditorProjectDto } from './public';
import { SiteAccessPolicy } from './site-access-policy';
import { SitesProjectTransactionLock } from './sites-project-transaction-lock';
import { editorProjectDto, replayEditorProject } from './site-project-view';
import { SitesApplicationError } from './sites-errors';
import { SITE_REPOSITORY, type SiteRepository } from './sites.ports';
import { requireCanonicalSiteConfig } from './validate-site-config';

type SaveProjectOutcome =
  | { readonly kind: 'saved'; readonly project: EditorProjectDto }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'media-not-ready' }
  | {
      readonly kind: 'version-conflict';
      readonly currentDraftVersion: number;
    };

export const SAVE_PROJECT_DRAFT = Symbol('SaveProjectDraft');

@Injectable()
export class SaveProjectDraft {
  constructor(
    @Inject(SITE_REPOSITORY) private readonly repository: SiteRepository,
    private readonly access: SiteAccessPolicy,
    private readonly idempotency: IdempotencyCoordinator,
    @Inject(APP_CONFIG) private readonly configuration: AppConfig,
    private readonly projectLock: SitesProjectTransactionLock,
    @Inject(MEDIA_MANAGED_REFERENCE_VALIDATION)
    private readonly media: MediaManagedReferenceValidation,
  ) {}

  async execute(input: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly userId: string;
    readonly operationId: string;
    readonly expectedDraftVersion: number;
    readonly siteConfig: unknown;
  }): Promise<EditorProjectDto> {
    const siteConfig = requireCanonicalSiteConfig(
      input.siteConfig,
      this.configuration.siteConfigRolloutMode,
    );
    await this.access.requireMember(input.workspaceId, input.userId);
    const execution = await this.idempotency.execute<SaveProjectOutcome>({
      key: {
        scope: `workspace:${input.workspaceId}:project:${input.projectId}`,
        operation: 'SAVE_DRAFT',
        key: input.operationId,
      },
      request: {
        operation: 'SAVE_DRAFT',
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        expectedDraftVersion: input.expectedDraftVersion,
        siteConfig: siteConfig.document,
      },
      command: async (context) => {
        await this.projectLock.acquire(context, input.projectId);
        const referencedAssetIds = managedMediaAssetIds(siteConfig.document);
        const media = await this.media.validate(context, {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          referencedAssetIds,
        });
        if (media.kind === 'not-ready') {
          return {
            httpStatus: 409,
            responseBody: {
              code: 'MEDIA_ASSET_NOT_READY',
              projectId: input.projectId,
              workspaceId: input.workspaceId,
            },
            resourceId: input.projectId,
            result: { kind: 'media-not-ready' } as const,
          };
        }
        const saved = await this.writeProjectDraft(context, {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          operationId: `SAVE_DRAFT:${input.operationId}`,
          expectedDraftVersion: input.expectedDraftVersion,
          siteConfig,
        });
        if (saved.kind === 'saved') {
          const project = editorProjectDto(saved.project, this.configuration);
          return {
            httpStatus: 200,
            responseBody: {
              projectId: project.id,
              workspaceId: project.workspaceId,
              publicSlug: project.publicSlug,
              publicUrl: project.publicUrl,
              draftVersion: project.draftVersion,
              schemaVersion: project.draftSchemaVersion,
            },
            resourceId: project.id,
            result: { kind: 'saved', project } as const,
          };
        }
        if (saved.kind === 'not-found') {
          return {
            httpStatus: 404,
            responseBody: {
              code: 'NOT_FOUND',
              projectId: input.projectId,
              workspaceId: input.workspaceId,
            },
            resourceId: null,
            result: { kind: 'not-found' } as const,
          };
        }
        if (saved.kind === 'version-conflict') {
          return {
            httpStatus: 409,
            responseBody: {
              code: 'PROJECT_VERSION_CONFLICT',
              projectId: input.projectId,
              workspaceId: input.workspaceId,
              draftVersion: saved.currentDraftVersion,
            },
            resourceId: input.projectId,
            result: {
              kind: 'version-conflict',
              currentDraftVersion: saved.currentDraftVersion,
            } as const,
          };
        }
        throw new Error('Revision operation exists without idempotency state');
      },
    });

    if (execution.kind === 'key-reused') {
      throw new SitesApplicationError('IDEMPOTENCY_KEY_REUSED');
    }
    if (execution.kind === 'executed') {
      return this.unwrap(execution.result);
    }
    const code = execution.record.responseBody.code;
    if (code === 'NOT_FOUND') throw new SitesApplicationError('NOT_FOUND');
    if (code === 'PROJECT_VERSION_CONFLICT') {
      const version = execution.record.responseBody.draftVersion;
      if (!Number.isSafeInteger(version)) {
        throw new Error('Stored version conflict is invalid');
      }
      throw new SitesApplicationError(
        'PROJECT_VERSION_CONFLICT',
        Number(version),
      );
    }
    if (code === 'MEDIA_ASSET_NOT_READY') {
      throw new SitesApplicationError('MEDIA_ASSET_NOT_READY');
    }
    if (code !== undefined) {
      throw new Error('Stored idempotency result is invalid');
    }
    return replayEditorProject(
      execution.record,
      this.repository,
      this.configuration,
      input.workspaceId,
      input.projectId,
    );
  }

  private unwrap(outcome: SaveProjectOutcome): EditorProjectDto {
    if (outcome.kind === 'saved') return outcome.project;
    if (outcome.kind === 'not-found') {
      throw new SitesApplicationError('NOT_FOUND');
    }
    if (outcome.kind === 'media-not-ready') {
      throw new SitesApplicationError('MEDIA_ASSET_NOT_READY');
    }
    throw new SitesApplicationError(
      'PROJECT_VERSION_CONFLICT',
      outcome.currentDraftVersion,
    );
  }

  private writeProjectDraft(
    context: Parameters<SiteRepository['saveDraft']>[0],
    input: Parameters<SiteRepository['saveDraft']>[1],
  ): ReturnType<SiteRepository['saveDraft']> {
    return this.repository.saveDraft(context, input);
  }
}
