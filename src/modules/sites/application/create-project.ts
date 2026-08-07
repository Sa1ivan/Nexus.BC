import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  APP_CONFIG,
  type AppConfig,
} from '../../../shared/config/app-config.schema';
import { IdempotencyCoordinator } from '../../../shared/idempotency/idempotency-coordinator';
import type { EditorProjectDto } from './public';
import { SiteAccessPolicy } from './site-access-policy';
import { editorProjectDto, replayEditorProject } from './site-project-view';
import { SitesApplicationError } from './sites-errors';
import { SITE_REPOSITORY, type SiteRepository } from './sites.ports';
import { requireCanonicalSiteConfig } from './validate-site-config';

@Injectable()
export class CreateProject {
  constructor(
    @Inject(SITE_REPOSITORY) private readonly repository: SiteRepository,
    private readonly access: SiteAccessPolicy,
    private readonly idempotency: IdempotencyCoordinator,
    @Inject(APP_CONFIG) private readonly configuration: AppConfig,
  ) {}

  async execute(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly operationId: string;
    readonly name: string;
    readonly siteConfig: unknown;
  }): Promise<EditorProjectDto> {
    const siteConfig = requireCanonicalSiteConfig(input.siteConfig);
    await this.access.requireMember(input.workspaceId, input.userId);
    const projectId = randomUUID();
    const publicSlug = `site-${randomUUID()}`;
    const request = {
      operation: 'CREATE_PROJECT',
      workspaceId: input.workspaceId,
      name: input.name,
      siteConfig,
    };
    const execution = await this.idempotency.execute({
      key: {
        scope: `workspace:${input.workspaceId}`,
        operation: 'CREATE_PROJECT',
        key: input.operationId,
      },
      request,
      command: async (context) => {
        const project = await this.repository.create(context, {
          id: projectId,
          workspaceId: input.workspaceId,
          operationId: `CREATE_PROJECT:${input.operationId}`,
          name: input.name,
          publicSlug,
          siteConfig,
        });
        const result = editorProjectDto(project, this.configuration);
        return {
          httpStatus: 201,
          responseBody: {
            id: result.id,
            workspaceId: result.workspaceId,
            publicSlug: result.publicSlug,
            publicUrl: result.publicUrl,
            draftVersion: result.draftVersion,
            schemaVersion: result.draftSchemaVersion,
          },
          resourceId: result.id,
          result,
        };
      },
    });
    if (execution.kind === 'key-reused') {
      throw new SitesApplicationError('IDEMPOTENCY_KEY_REUSED');
    }
    if (execution.kind === 'executed') return execution.result;
    return replayEditorProject(
      execution.record,
      this.repository,
      this.configuration,
      input.workspaceId,
    );
  }
}
