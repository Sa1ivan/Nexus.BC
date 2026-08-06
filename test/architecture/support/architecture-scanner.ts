import ts from 'typescript';
import type {
  RestrictedBinding,
  RestrictedOrigin,
} from '../types/architecture.types';
import {
  collectImportLikeDependencies,
  collectUnverifiableImportLikes,
} from './import-like-dependencies';
import { collectApplicationPublicViolations } from './application-public';
import { isControllerSourceFile } from './controller-detection';
import { collectControllerHandlerViolations } from './controller-handler-delegation';
import { resolveTerminalDependencyFiles } from './module-dependency-resolver';
import {
  allowedSameModuleDependencies,
  classifyModuleLocation,
  isExactApplicationPublic,
  listTypeScriptFiles,
  mayUsePrisma,
  mayUseProvider,
  modulesRoot,
  readCompilerOptions,
  resolveImport,
  sourceRoot,
  toSourceRelativePath,
} from './module-paths';
import { collectRestrictedBindings } from './restricted-binding-collector';
import { createOriginResolver } from './restricted-origin-resolver';
import {
  isGeneratedPrismaSourceFile,
  isPrismaImport,
  isProviderSdkImport,
  referencesPrismaServiceLikeSymbol,
  restrictedOriginsForSpecifier,
  restrictedOriginLabel,
} from './restricted-origin';
import { collectPrismaDelegateWrites } from './prisma-delegate-ownership';

function addRestrictedBindingViolations(
  bindings: readonly RestrictedBinding[],
  relativeSourcePath: string,
  isController: boolean,
  sourceFilePath: string,
  projectSourceRoot: string,
  projectModulesRoot: string,
  violations: string[],
): void {
  const prismaAllowed = mayUsePrisma(
    sourceFilePath,
    projectSourceRoot,
    projectModulesRoot,
  );

  for (const binding of bindings) {
    for (const origin of binding.origins) {
      const isPrismaOrigin = origin === 'prisma' || origin === 'prisma-service';
      const label = restrictedOriginLabel(origin);

      if (isPrismaOrigin && !prismaAllowed) {
        violations.push(
          `${relativeSourcePath} may not consume ${label} symbol ${binding.name} outside approved infrastructure adapters`,
        );
      }
      if (isController && isPrismaOrigin) {
        violations.push(
          `${relativeSourcePath} controller may not consume ${label} symbol ${binding.name}`,
        );
      }
      if (isController && isProviderOrigin(origin)) {
        violations.push(
          `${relativeSourcePath} controller may not consume ${label} symbol ${binding.name}`,
        );
      }
      if (
        isProviderOrigin(origin) &&
        !mayUseProvider(
          origin,
          sourceFilePath,
          projectSourceRoot,
          projectModulesRoot,
        )
      ) {
        const owner =
          origin === 'aws-sdk'
            ? 'modules/media/infrastructure'
            : 'modules/notifications/infrastructure';
        violations.push(
          `${relativeSourcePath} may not consume ${label} symbol ${binding.name} outside ${owner}`,
        );
      }
    }
  }
}

function isProviderOrigin(
  origin: RestrictedOrigin,
): origin is 'aws-sdk' | 'resend' {
  return origin === 'aws-sdk' || origin === 'resend';
}

export function findArchitectureViolations(
  projectSourceRoot = sourceRoot,
  projectModulesRoot = modulesRoot,
): string[] {
  const compilerOptions = readCompilerOptions();
  const sourceFilePaths = listTypeScriptFiles(projectSourceRoot).filter(
    (sourceFilePath) =>
      !isGeneratedPrismaSourceFile(sourceFilePath, projectSourceRoot),
  );
  const program = ts.createProgram(sourceFilePaths, compilerOptions);
  const resolver = createOriginResolver(
    program,
    compilerOptions,
    projectSourceRoot,
  );
  const violations: string[] = [];

  for (const sourceFilePath of sourceFilePaths) {
    const sourceFile = program.getSourceFile(sourceFilePath);
    if (sourceFile === undefined) {
      violations.push(
        `Unable to parse ${toSourceRelativePath(sourceFilePath, projectSourceRoot)}`,
      );
      continue;
    }

    const relativeSourcePath = toSourceRelativePath(
      sourceFilePath,
      projectSourceRoot,
    );
    const sourceLocation = classifyModuleLocation(
      sourceFilePath,
      projectModulesRoot,
    );
    const isController = isControllerSourceFile(sourceFile, resolver.checker);
    const importDependencies = collectImportLikeDependencies(
      sourceFile,
      resolver.checker,
    );
    const unverifiableDependencies = collectUnverifiableImportLikes(
      sourceFile,
      resolver.checker,
    );
    const restrictedBindings = collectRestrictedBindings(sourceFile, resolver);

    if (
      sourceLocation !== undefined &&
      sourceLocation.layer === 'application' &&
      isExactApplicationPublic(
        sourceFilePath,
        sourceLocation.moduleName,
        projectSourceRoot,
      )
    ) {
      violations.push(
        ...collectApplicationPublicViolations(
          sourceFile,
          relativeSourcePath,
          sourceLocation.moduleName,
          projectModulesRoot,
          resolver,
        ),
      );
    }

    if (isController && sourceLocation !== undefined) {
      violations.push(
        ...collectControllerHandlerViolations(
          sourceFile,
          relativeSourcePath,
          sourceLocation.moduleName,
          projectModulesRoot,
          resolver.checker,
        ),
      );
    }

    for (const operation of unverifiableDependencies) {
      violations.push(
        `${relativeSourcePath} has a non-literal ${operation}() dependency; architecture dependencies must use string literals`,
      );
    }

    addRestrictedBindingViolations(
      restrictedBindings,
      relativeSourcePath,
      isController,
      sourceFilePath,
      projectSourceRoot,
      projectModulesRoot,
      violations,
    );

    if (mayUsePrisma(sourceFilePath, projectSourceRoot, projectModulesRoot)) {
      const prismaOwner =
        sourceLocation?.layer === 'infrastructure'
          ? sourceLocation.moduleName
          : relativeSourcePath.startsWith('shared/audit/')
            ? 'shared/audit'
            : relativeSourcePath.startsWith('shared/idempotency/')
              ? 'shared/idempotency'
              : undefined;
      if (prismaOwner !== undefined) {
        for (const write of collectPrismaDelegateWrites(sourceFile)) {
          if (write.owner !== prismaOwner) {
            violations.push(
              `${relativeSourcePath} may not call Prisma write delegate ${write.delegate}.${write.operation}; ${write.delegate} belongs to ${write.owner}`,
            );
          }
        }
      }
    }

    for (const dependency of importDependencies) {
      const { specifier } = dependency;
      const resolvedImport = resolveImport(
        specifier,
        sourceFilePath,
        compilerOptions,
      );
      const directTargetLocation =
        resolvedImport === undefined
          ? undefined
          : classifyModuleLocation(resolvedImport, projectModulesRoot);
      if (
        (isPrismaImport(specifier) ||
          isGeneratedPrismaSourceFile(resolvedImport, projectSourceRoot)) &&
        !mayUsePrisma(sourceFilePath, projectSourceRoot, projectModulesRoot)
      ) {
        violations.push(
          `${relativeSourcePath} may not import ${specifier}; Prisma access belongs in approved infrastructure adapters`,
        );
      }

      if (isController && isProviderSdkImport(specifier)) {
        violations.push(
          `${relativeSourcePath} controller may not import provider SDK ${specifier}`,
        );
      }

      for (const origin of restrictedOriginsForSpecifier(specifier)) {
        if (
          isProviderOrigin(origin) &&
          !mayUseProvider(
            origin,
            sourceFilePath,
            projectSourceRoot,
            projectModulesRoot,
          )
        ) {
          const owner =
            origin === 'aws-sdk'
              ? 'modules/media/infrastructure'
              : 'modules/notifications/infrastructure';
          violations.push(
            `${relativeSourcePath} may not import ${specifier}; ${restrictedOriginLabel(origin)} belongs in ${owner}`,
          );
        }
      }

      if (sourceLocation === undefined) {
        if (
          relativeSourcePath.startsWith('shared/') &&
          resolvedImport !== undefined &&
          directTargetLocation !== undefined
        ) {
          violations.push(
            `${relativeSourcePath} crosses into ${toSourceRelativePath(resolvedImport, projectSourceRoot)}; shared code may not depend on business modules`,
          );
        }
        continue;
      }

      for (const terminalFile of resolveTerminalDependencyFiles(
        dependency,
        sourceFilePath,
        resolver,
      )) {
        const targetLocation = classifyModuleLocation(
          terminalFile,
          projectModulesRoot,
        );
        if (targetLocation === undefined) {
          continue;
        }

        if (sourceLocation.moduleName !== targetLocation.moduleName) {
          const entersThroughOwnerPublic =
            resolvedImport !== undefined &&
            directTargetLocation?.moduleName === targetLocation.moduleName &&
            targetLocation.layer === 'application' &&
            isExactApplicationPublic(
              resolvedImport,
              targetLocation.moduleName,
              projectSourceRoot,
            );
          if (!entersThroughOwnerPublic) {
            violations.push(
              `${relativeSourcePath} crosses into ${toSourceRelativePath(terminalFile, projectSourceRoot)}; cross-module imports must target application/public.ts`,
            );
          }
          continue;
        }

        if (
          !sourceLocation.isCompositionRoot &&
          (sourceLocation.layer === undefined ||
            targetLocation.layer === undefined ||
            !allowedSameModuleDependencies[sourceLocation.layer].has(
              targetLocation.layer,
            ))
        ) {
          violations.push(
            `${relativeSourcePath} may not depend on ${toSourceRelativePath(terminalFile, projectSourceRoot)}`,
          );
        }
      }
    }

    if (
      referencesPrismaServiceLikeSymbol(sourceFile) &&
      !mayUsePrisma(sourceFilePath, projectSourceRoot, projectModulesRoot)
    ) {
      violations.push(
        `${relativeSourcePath} may not reference PrismaService outside approved infrastructure adapters`,
      );
    }
  }

  return [...new Set(violations)];
}
