import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { ModuleLayer, ModuleLocation } from '../types/architecture.types';

export const repositoryRoot = path.resolve(__dirname, '../../..');
export const sourceRoot = path.join(repositoryRoot, 'src');
export const modulesRoot = path.join(sourceRoot, 'modules');

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
  const relativePath = path.relative(projectModulesRoot, filePath);

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
  return ts.resolveModuleName(
    specifier,
    sourceFilePath,
    compilerOptions,
    ts.sys,
  ).resolvedModule?.resolvedFileName;
}

export function toSourceRelativePath(
  filePath: string,
  projectSourceRoot = sourceRoot,
): string {
  return path.relative(projectSourceRoot, filePath).split(path.sep).join('/');
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

function isNamedPrismaAdapter(relativePath: string): boolean {
  const segments = relativePath.split('/');
  const fileName = segments.at(-1);
  const sharedArea = segments[1];

  return (
    segments[0] === 'shared' &&
    (sharedArea === 'idempotency' || sharedArea === 'audit') &&
    fileName !== undefined &&
    /^prisma(?:-[a-z0-9-]+)?\.adapter\.ts$/u.test(fileName)
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
    relativePath === 'shared/database.ts' ||
    relativePath.startsWith('shared/database/') ||
    isNamedPrismaAdapter(relativePath)
  );
}
