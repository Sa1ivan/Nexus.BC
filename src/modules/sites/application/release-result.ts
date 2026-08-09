import type { StoredIdempotencyRecord } from '../../../shared/idempotency/idempotency-store';
import type { Release } from '../domain/release';
import type { ReleaseResultDto } from './public';
import type { SiteRepository } from './sites.ports';

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Stored idempotency ${field} is invalid`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`Stored idempotency ${field} is invalid`);
  }
  return Number(value);
}

function hasExactFields(value: object, fields: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...fields].sort().join(',');
}

export function releaseResultDto(release: Release): ReleaseResultDto {
  return Object.freeze({
    releaseId: release.id,
    projectId: release.projectId,
    version: release.version,
    schemaVersion: release.schemaVersion,
  });
}

export async function replayReleaseResult(
  record: StoredIdempotencyRecord,
  repository: SiteRepository,
  workspaceId: string,
  projectId: string,
  expectedReleaseId?: string,
): Promise<ReleaseResultDto> {
  const body = record.responseBody;
  const releaseId = requiredString(body.releaseId, 'release id');
  const storedProjectId = requiredString(body.projectId, 'project id');
  const version = requiredPositiveInteger(body.version, 'release version');
  if (
    record.httpStatus !== 200 ||
    record.resourceId !== releaseId ||
    !hasExactFields(body, [
      'projectId',
      'releaseId',
      'schemaVersion',
      'version',
    ]) ||
    body.schemaVersion !== 4 ||
    storedProjectId !== projectId ||
    (expectedReleaseId !== undefined && releaseId !== expectedReleaseId)
  ) {
    throw new Error('Stored idempotency release result is invalid');
  }
  const release = await repository.findReleaseForWorkspace(
    workspaceId,
    projectId,
    releaseId,
  );
  if (
    release === null ||
    release.version !== version ||
    release.schemaVersion !== 4
  ) {
    throw new Error('Stored idempotency release snapshot is unavailable');
  }
  return releaseResultDto(release);
}
