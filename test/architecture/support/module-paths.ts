import { existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { ModuleLayer, ModuleLocation } from '../types/architecture.types';

export const repositoryRoot = path.resolve(__dirname, '../../..');
export const sourceRoot = path.join(repositoryRoot, 'src');
export const modulesRoot = path.join(sourceRoot, 'modules');

export function canonicalPath(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export const requiredModules = [
  'auth',
  'workspaces',
  'sites',
  'media',
  'forms',
  'notifications',
] as const;

export const allowedSameModuleDependencies: Readonly<
  Record<ModuleLayer, ReadonlySet<ModuleLayer>>
> = {
  api: new Set(['api', 'application', 'domain']),
  application: new Set(['application', 'domain']),
  domain: new Set(['domain']),
  infrastructure: new Set(['infrastructure', 'application', 'domain']),
};

export function listTypeScriptFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return listTypeScriptFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
  });
}

function isModuleLayer(value: string): value is ModuleLayer {
  return (
    value === 'api' ||
    value === 'application' ||
    value === 'domain' ||
    value === 'infrastructure'
  );
}

export function classifyModuleLocation(
  filePath: string,
  projectModulesRoot = modulesRoot,
): ModuleLocation | undefined {
  const relativePath = path.relative(
    canonicalPath(projectModulesRoot),
    canonicalPath(filePath),
  );

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined;
  }

  const segments = relativePath.split(path.sep);
  const moduleName = segments[0];
  const possibleLayer = segments[1];

  if (moduleName === undefined || possibleLayer === undefined) {
    return undefined;
  }

  return {
    moduleName,
    layer: isModuleLayer(possibleLayer) ? possibleLayer : undefined,
    isCompositionRoot:
      segments.length === 2 && possibleLayer === `${moduleName}.module.ts`,
  };
}

export function readCompilerOptions(): ts.CompilerOptions {
  const configPath = path.join(repositoryRoot, 'tsconfig.json');
  const configSource = ts.readJsonConfigFile(configPath, (fileName) =>
    ts.sys.readFile(fileName),
  );
  const parsedConfig = ts.parseJsonSourceFileConfigFileContent(
    configSource,
    ts.sys,
    repositoryRoot,
  );

  if (parsedConfig.errors.length > 0) {
    const message = ts.formatDiagnosticsWithColorAndContext(
      parsedConfig.errors,
      {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => repositoryRoot,
        getNewLine: () => ts.sys.newLine,
      },
    );
    throw new Error(message);
  }

  return parsedConfig.options;
}

export function resolveImport(
  specifier: string,
  sourceFilePath: string,
  compilerOptions: ts.CompilerOptions,
): string | undefined {
  const resolvedFileName = ts.resolveModuleName(
    specifier,
    sourceFilePath,
    compilerOptions,
    ts.sys,
  ).resolvedModule?.resolvedFileName;
  return resolvedFileName === undefined
    ? undefined
    : canonicalPath(resolvedFileName);
}

export function toSourceRelativePath(
  filePath: string,
  projectSourceRoot = sourceRoot,
): string {
  return path
    .relative(canonicalPath(projectSourceRoot), canonicalPath(filePath))
    .split(path.sep)
    .join('/');
}

export function isExactApplicationPublic(
  filePath: string,
  moduleName: string,
  projectSourceRoot = sourceRoot,
): boolean {
  return (
    toSourceRelativePath(filePath, projectSourceRoot) ===
    `modules/${moduleName}/application/public.ts`
  );
}

export function mayUsePrisma(
  filePath: string,
  projectSourceRoot = sourceRoot,
  projectModulesRoot = modulesRoot,
): boolean {
  const moduleLocation = classifyModuleLocation(filePath, projectModulesRoot);
  if (moduleLocation?.layer === 'infrastructure') {
    return true;
  }

  const relativePath = toSourceRelativePath(filePath, projectSourceRoot);
  return (
    relativePath.startsWith('shared/database/') ||
    relativePath === 'shared/audit/prisma-audit-writer.ts' ||
    relativePath === 'shared/idempotency/prisma-idempotency.adapter.ts'
  );
}

export function mayUseProvider(
  provider: 'aws-sdk' | 'resend',
  filePath: string,
  projectSourceRoot = sourceRoot,
  projectModulesRoot = modulesRoot,
): boolean {
  if (
    provider === 'aws-sdk' &&
    toSourceRelativePath(filePath, projectSourceRoot) ===
      'shared/audit/infrastructure/r2-recovery-audit-storage.ts'
  ) {
    return true;
  }
  const location = classifyModuleLocation(filePath, projectModulesRoot);
  if (location?.layer !== 'infrastructure') {
    return false;
  }
  return provider === 'aws-sdk'
    ? location.moduleName === 'media'
    : location.moduleName === 'notifications';
}
