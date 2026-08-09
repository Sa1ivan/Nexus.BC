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

type ActivateReleaseOutcome =
  | { readonly kind: 'activated'; readonly release: ReleaseResultDto }
  | { readonly kind: 'not-found' };

function hasExactFields(value: object, fields: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...fields].sort().join(',');
}

function assertActivationNotFoundReplay(
  record: StoredIdempotencyRecord,
  workspaceId: string,
  projectId: string,
  releaseId: string,
): void {
  const body = record.responseBody;
  if (
    record.httpStatus !== 404 ||
    record.resourceId !== null ||
    !hasExactFields(body, ['code', 'projectId', 'releaseId', 'workspaceId']) ||
    body.code !== 'NOT_FOUND' ||
    body.workspaceId !== workspaceId ||
    body.projectId !== projectId ||
    body.releaseId !== releaseId
  ) {
    throw new Error('Stored idempotency activation result is invalid');
  }
}

@Injectable()
export class ActivateRelease {
  constructor(
    @Inject(SITE_REPOSITORY) private readonly repository: SiteRepository,
    private readonly access: SiteAccessPolicy,
    private readonly idempotency: IdempotencyCoordinator,
    @Inject(AUDIT_WRITER) private readonly audit: AuditWriter,
  ) {}

  async execute(input: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly releaseId: string;
    readonly userId: string;
    readonly operationId: string;
    readonly requestId: string;
  }): Promise<ReleaseResultDto> {
    await this.access.requireMember(input.workspaceId, input.userId);
    const execution = await this.idempotency.execute<ActivateReleaseOutcome>({
      key: {
        scope: `workspace:${input.workspaceId}:project:${input.projectId}`,
        operation: 'ACTIVATE_RELEASE',
        key: input.operationId,
      },
      request: {
        operation: 'ACTIVATE_RELEASE',
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        releaseId: input.releaseId,
      },
      command: async (context) => {
        const activated = await this.repository.activateRelease(context, {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          releaseId: input.releaseId,
        });
        if (activated.kind === 'not-found') {
          return {
            httpStatus: 404,
            responseBody: {
              code: 'NOT_FOUND',
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              releaseId: input.releaseId,
            },
            resourceId: null,
            result: { kind: 'not-found' } as const,
          };
        }
        const release = releaseResultDto(activated.release);
        await this.audit.append(context, {
          eventId: randomUUID(),
          workspaceId: input.workspaceId,
          actorUserId: input.userId,
          action: 'RELEASE_ACTIVATED',
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
          result: { kind: 'activated', release } as const,
        };
      },
    });

    if (execution.kind === 'key-reused') {
      throw new SitesApplicationError('IDEMPOTENCY_KEY_REUSED');
    }
    if (execution.kind === 'executed') {
      if (execution.result.kind === 'not-found') {
        throw new SitesApplicationError('NOT_FOUND');
      }
      return execution.result.release;
    }
    const code = execution.record.responseBody.code;
    if (code === 'NOT_FOUND') {
      assertActivationNotFoundReplay(
        execution.record,
        input.workspaceId,
        input.projectId,
        input.releaseId,
      );
      throw new SitesApplicationError('NOT_FOUND');
    }
    if (code !== undefined) {
      throw new Error('Stored idempotency result is invalid');
    }
    return replayReleaseResult(
      execution.record,
      this.repository,
      input.workspaceId,
      input.projectId,
      input.releaseId,
    );
  }
}
