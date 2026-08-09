import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AUDIT_WRITER,
  type AuditWriter,
} from '../../../shared/audit/audit-writer';
import { IdempotencyCoordinator } from '../../../shared/idempotency/idempotency-coordinator';
import type { StoredIdempotencyRecord } from '../../../shared/idempotency/idempotency-store';
import type { ReleaseResultDto } from './public';
import { releaseResultDto, replayReleaseResult } from './release-result';
import { SiteAccessPolicy } from './site-access-policy';
import { SitesApplicationError } from './sites-errors';
import { SITE_REPOSITORY, type SiteRepository } from './sites.ports';
import { requireCanonicalSiteConfig } from './validate-site-config';

type PublishProjectOutcome =
  | { readonly kind: 'published'; readonly release: ReleaseResultDto }
  | { readonly kind: 'not-found' }
  | {
      readonly kind: 'version-conflict';
      readonly currentDraftVersion: number;
    };

function hasExactFields(value: object, fields: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...fields].sort().join(',');
}

function assertPublishNotFoundReplay(
  record: StoredIdempotencyRecord,
  workspaceId: string,
  projectId: string,
): void {
  const body = record.responseBody;
  if (
    record.httpStatus !== 404 ||
    record.resourceId !== null ||
    !hasExactFields(body, ['code', 'projectId', 'workspaceId']) ||
    body.code !== 'NOT_FOUND' ||
    body.workspaceId !== workspaceId ||
    body.projectId !== projectId
  ) {
    throw new Error('Stored idempotency publish result is invalid');
  }
}

function publishConflictVersion(
  record: StoredIdempotencyRecord,
  workspaceId: string,
  projectId: string,
): number {
  const body = record.responseBody;
  if (
    record.httpStatus !== 409 ||
    record.resourceId !== projectId ||
    !hasExactFields(body, [
      'code',
      'draftVersion',
      'projectId',
      'workspaceId',
    ]) ||
    body.code !== 'PROJECT_VERSION_CONFLICT' ||
    body.workspaceId !== workspaceId ||
    body.projectId !== projectId ||
    !Number.isSafeInteger(body.draftVersion) ||
    Number(body.draftVersion) < 1
  ) {
    throw new Error('Stored idempotency publish result is invalid');
  }
  return Number(body.draftVersion);
}

@Injectable()
export class PublishProject {
  constructor(
    @Inject(SITE_REPOSITORY) private readonly repository: SiteRepository,
    private readonly access: SiteAccessPolicy,
    private readonly idempotency: IdempotencyCoordinator,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  async execute(input: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly userId: string;
    readonly operationId: string;
    readonly requestId: string;
    readonly expectedDraftVersion: number;
    readonly siteConfig: unknown;
  }): Promise<ReleaseResultDto> {
    const siteConfig = requireCanonicalSiteConfig(input.siteConfig);
    await this.access.requireMember(input.workspaceId, input.userId);
    const execution = await this.idempotency.execute<PublishProjectOutcome>({
      key: {
        scope: `workspace:${input.workspaceId}:project:${input.projectId}`,
        operation: 'PUBLISH_PROJECT',
        key: input.operationId,
      },
      request: {
        operation: 'PUBLISH_PROJECT',
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        expectedDraftVersion: input.expectedDraftVersion,
        siteConfig,
      },
      command: async (context) => {
        const published = await this.repository.publishProject(context, {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          operationId: `PUBLISH_PROJECT:${input.operationId}`,
          expectedDraftVersion: input.expectedDraftVersion,
          siteConfig,
        });
        if (published.kind === 'published') {
          const release = releaseResultDto(published.release);
          await this.audit.append(context, {
            eventId: randomUUID(),
            workspaceId: input.workspaceId,
            actorUserId: input.userId,
            action: 'PROJECT_PUBLISHED',
            resourceType: 'Release',
            resourceId: release.releaseId,
            metadata: {
              projectId: release.projectId,
              version: release.version,
            },
            requestId: input.requestId,
          });
          return {
            httpStatus: 200,
            responseBody: release,
            resourceId: release.releaseId,
            result: { kind: 'published', release } as const,
          };
        }
        if (published.kind === 'not-found') {
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
        if (published.kind === 'version-conflict') {
          return {
            httpStatus: 409,
            responseBody: {
              code: 'PROJECT_VERSION_CONFLICT',
              projectId: input.projectId,
              workspaceId: input.workspaceId,
              draftVersion: published.currentDraftVersion,
            },
            resourceId: input.projectId,
            result: {
              kind: 'version-conflict',
              currentDraftVersion: published.currentDraftVersion,
            } as const,
          };
        }
        throw new Error('Publish operation exists without idempotency state');
      },
    });

    if (execution.kind === 'key-reused') {
      throw new SitesApplicationError('IDEMPOTENCY_KEY_REUSED');
    }
    if (execution.kind === 'executed') return this.unwrap(execution.result);
    const code = execution.record.responseBody.code;
    if (code === 'NOT_FOUND') {
      assertPublishNotFoundReplay(
        execution.record,
        input.workspaceId,
        input.projectId,
      );
      throw new SitesApplicationError('NOT_FOUND');
    }
    if (code === 'PROJECT_VERSION_CONFLICT') {
      const version = publishConflictVersion(
        execution.record,
        input.workspaceId,
        input.projectId,
      );
      throw new SitesApplicationError('PROJECT_VERSION_CONFLICT', version);
    }
    if (code !== undefined) {
      throw new Error('Stored idempotency result is invalid');
    }
    return replayReleaseResult(
      execution.record,
      this.repository,
      input.workspaceId,
      input.projectId,
    );
  }

  private unwrap(outcome: PublishProjectOutcome): ReleaseResultDto {
    if (outcome.kind === 'published') return outcome.release;
    if (outcome.kind === 'not-found') {
      throw new SitesApplicationError('NOT_FOUND');
    }
    throw new SitesApplicationError(
      'PROJECT_VERSION_CONFLICT',
      outcome.currentDraftVersion,
    );
  }
}
