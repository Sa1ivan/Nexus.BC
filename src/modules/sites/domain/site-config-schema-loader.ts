import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function resolveSiteConfigSchemaPath(moduleDirectory: string): string {
  const artifactPath = resolve(
    moduleDirectory,
    '../../../../contracts/site-config/v4.schema.json',
  );
  if (!existsSync(artifactPath)) {
    throw new Error('SiteConfig v4 schema artifact is unavailable.');
  }
  return artifactPath;
}
