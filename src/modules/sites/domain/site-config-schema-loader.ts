import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function resolveSiteConfigSchemaPath(
  moduleDirectory: string,
  version: 4 | 5 = 4,
): string {
  const artifactPath = resolve(
    moduleDirectory,
    `../../../../contracts/site-config/v${version}.schema.json`,
  );
  if (!existsSync(artifactPath)) {
    throw new Error(`SiteConfig v${version} schema artifact is unavailable.`);
  }
  return artifactPath;
}
