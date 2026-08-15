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

function requiredSchemaVersion(value: unknown): 4 | 5 {
  if (value !== 4 && value !== 5) {
    throw new Error('Stored idempotency schema version is invalid');
  }
  return value;
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
  expectations: {
    readonly releaseId?: string;
    readonly operationId?: string;
  } = {},
): Promise<ReleaseResultDto> {
  const body = record.responseBody;
  const releaseId = requiredString(body.releaseId, 'release id');
  const storedProjectId = requiredString(body.projectId, 'project id');
  const version = requiredPositiveInteger(body.version, 'release version');
  const schemaVersion = requiredSchemaVersion(body.schemaVersion);
  if (
    record.httpStatus !== 200 ||
    record.resourceId !== releaseId ||
    !hasExactFields(body, [
      'projectId',
      'releaseId',
      'schemaVersion',
      'version',
    ]) ||
    storedProjectId !== projectId ||
    (expectations.releaseId !== undefined &&
      releaseId !== expectations.releaseId)
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
    release.schemaVersion !== schemaVersion
  ) {
    throw new Error('Stored idempotency release snapshot is unavailable');
  }
  if (
    expectations.operationId !== undefined &&
    release.operationId !== expectations.operationId
  ) {
    throw new Error(
      'Stored idempotency release result does not belong to its operation',
    );
  }
  return releaseResultDto(release);
}
