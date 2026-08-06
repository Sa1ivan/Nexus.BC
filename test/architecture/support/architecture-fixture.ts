import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ArchitectureFixture } from '../types/architecture.types';

export function createArchitectureFixture(
  files: Readonly<Record<string, string>>,
): ArchitectureFixture {
  const projectRoot = mkdtempSync(
    path.join(tmpdir(), 'nexus-architecture-fixture-'),
  );
  const fixtureSourceRoot = path.join(projectRoot, 'src');

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(fixtureSourceRoot, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents, 'utf8');
  }

  return {
    projectRoot,
    sourceRoot: fixtureSourceRoot,
    modulesRoot: path.join(fixtureSourceRoot, 'modules'),
  };
}

export function createArchitectureProjectFile(
  fixture: ArchitectureFixture,
  relativePath: string,
  contents: string,
): void {
  const filePath = path.join(fixture.projectRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, 'utf8');
}

export function removeArchitectureFixture(fixture: ArchitectureFixture): void {
  rmSync(fixture.projectRoot, { recursive: true, force: true });
}

export function createArchitectureSymlink(
  fixture: ArchitectureFixture,
  relativePath: string,
  targetRelativePath: string,
): void {
  const linkPath = path.join(fixture.sourceRoot, relativePath);
  mkdirSync(path.dirname(linkPath), { recursive: true });
  symlinkSync(targetRelativePath, linkPath);
}
