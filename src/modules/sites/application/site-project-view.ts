import type { AppConfig } from '../../../shared/config/app-config.schema';
import type { StoredIdempotencyRecord } from '../../../shared/idempotency/idempotency-store';
import type { Project } from '../domain/project';
import type { ProjectRevision } from '../domain/project-revision';
import type {
  EditorProjectDto,
  ProjectRevisionMetadataDto,
  ProjectSummaryDto,
} from './public';
import type { ProjectSummary, SiteRepository } from './sites.ports';

function applicationOrigin(configuration: AppConfig): string {
  const origin = configuration.webOrigins[0];
  if (origin === undefined)
    throw new Error('Application origin is unavailable');
  return origin;
}

export function projectPublicUrl(
  configuration: AppConfig,
  publicSlug: string,
): string {
  return `${applicationOrigin(configuration)}/p/${encodeURIComponent(publicSlug)}`;
}

export function editorProjectDto(
  project: Project,
  configuration: AppConfig,
  revision?: ProjectRevision,
): EditorProjectDto {
  return {
    id: project.id,
    workspaceId: project.workspaceId,
    name: project.name,
    publicSlug: project.publicSlug,
    publicUrl: projectPublicUrl(configuration, project.publicSlug),
    siteConfig: revision?.siteConfig ?? project.draft,
    draftSchemaVersion: revision?.schemaVersion ?? project.draftSchemaVersion,
    draftVersion: revision?.version ?? project.draftVersion,
  };
}

export function projectSummaryDto(
  summary: ProjectSummary,
  configuration: AppConfig,
): ProjectSummaryDto {
  return {
    id: summary.id,
    workspaceId: summary.workspaceId,
    name: summary.name,
    publicSlug: summary.publicSlug,
    publicUrl: projectPublicUrl(configuration, summary.publicSlug),
    updatedAt: summary.updatedAt.toISOString(),
  };
}

export function projectRevisionMetadataDto(
  revision: ProjectRevision,
): ProjectRevisionMetadataDto {
  return {
    id: revision.id,
    projectId: revision.projectId,
    version: revision.version,
    schemaVersion: revision.schemaVersion,
    createdAt: revision.createdAt.toISOString(),
  };
}

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

export async function replayEditorProject(
  record: StoredIdempotencyRecord,
  repository: SiteRepository,
  configuration: AppConfig,
  workspaceId: string,
  expectedProjectId?: string,
): Promise<EditorProjectDto> {
  const body = record.responseBody;
  const projectId = requiredString(body.id ?? body.projectId, 'project id');
  const storedWorkspaceId = requiredString(body.workspaceId, 'workspace id');
  const draftVersion = requiredPositiveInteger(
    body.draftVersion,
    'draft version',
  );
  if (
    body.schemaVersion !== 4 ||
    storedWorkspaceId !== workspaceId ||
    (expectedProjectId !== undefined && projectId !== expectedProjectId)
  ) {
    throw new Error('Stored idempotency project identity is invalid');
  }
  const project = await repository.findForWorkspace(workspaceId, projectId);
  const revision = await repository.findRevisionForWorkspace(
    workspaceId,
    projectId,
    draftVersion,
  );
  if (project === null || revision === null) {
    throw new Error('Stored idempotency project snapshot is unavailable');
  }
  const dto = editorProjectDto(project, configuration, revision);
  if (body.publicSlug !== dto.publicSlug || body.publicUrl !== dto.publicUrl) {
    throw new Error('Stored idempotency public identity is invalid');
  }
  return dto;
}
