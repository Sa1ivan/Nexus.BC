import path from 'node:path';
import ts from 'typescript';
import type {
  RestrictedBinding,
  RestrictedOrigin,
} from '../types/architecture.types';
import {
  collectImportLikeSpecifiers,
  collectUnverifiableImportLikes,
} from './import-like-dependencies';
import {
  allowedSameModuleDependencies,
  classifyModuleLocation,
  isExactApplicationPublic,
  listTypeScriptFiles,
  mayUsePrisma,
  modulesRoot,
  readCompilerOptions,
  resolveImport,
  sourceRoot,
  toSourceRelativePath,
} from './module-paths';
import { collectRestrictedBindings } from './restricted-binding-collector';
import {
  createOriginResolver,
  referencesPrismaServiceLikeSymbol,
} from './restricted-origin-resolver';
import {
  enclosingModuleSpecifier,
  isPrismaImport,
  isProviderSdkImport,
  referencedExportName,
  restrictedOriginLabel,
} from './restricted-origin';

function isNestControllerSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  if (seen.has(symbol)) {
    return false;
  }
  seen.add(symbol);

  for (const declaration of symbol.getDeclarations() ?? []) {
    const specifier = enclosingModuleSpecifier(declaration);
    if (
      specifier === '@nestjs/common' &&
      referencedExportName(declaration) === 'Controller'
    ) {
      return true;
    }

    const normalizedFileName = declaration
      .getSourceFile()
      .fileName.split(path.sep)
      .join('/');
    if (
      symbol.getName() === 'Controller' &&
      normalizedFileName.includes('/node_modules/@nestjs/common/')
    ) {
      return true;
    }
  }

  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const aliasedSymbol = checker.getAliasedSymbol(symbol);
    if (
      aliasedSymbol !== symbol &&
      isNestControllerSymbol(aliasedSymbol, checker, seen)
    ) {
      return true;
    }
  }

  return false;
}

function hasNestControllerDecorator(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): boolean {
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }

    if (ts.isClassDeclaration(node)) {
      const decorators = ts.canHaveDecorators(node)
        ? ts.getDecorators(node)
        : undefined;
      for (const decorator of decorators ?? []) {
        const target = ts.isCallExpression(decorator.expression)
          ? decorator.expression.expression
          : decorator.expression;
        const symbol = checker.getSymbolAtLocation(target);
        if (symbol !== undefined && isNestControllerSymbol(symbol, checker)) {
          found = true;
          return;
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

function isControllerSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): boolean {
  return (
    sourceFile.fileName.endsWith('.controller.ts') ||
    hasNestControllerDecorator(sourceFile, checker)
  );
}

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
    }
  }
}

function isProviderOrigin(origin: RestrictedOrigin): boolean {
  return origin === 'aws-sdk' || origin === 'resend';
}

export function findArchitectureViolations(
  projectSourceRoot = sourceRoot,
  projectModulesRoot = modulesRoot,
): string[] {
  const compilerOptions = readCompilerOptions();
  const sourceFilePaths = listTypeScriptFiles(projectSourceRoot);
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
    const importSpecifiers = collectImportLikeSpecifiers(
      sourceFile,
      resolver.checker,
    );
    const unverifiableDependencies = collectUnverifiableImportLikes(
      sourceFile,
      resolver.checker,
    );
    const restrictedBindings = collectRestrictedBindings(sourceFile, resolver);

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

    for (const specifier of importSpecifiers) {
      if (
        isPrismaImport(specifier) &&
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

      if (sourceLocation === undefined) {
        continue;
      }

      const resolvedImport = resolveImport(
        specifier,
        sourceFilePath,
        compilerOptions,
      );
      if (resolvedImport === undefined) {
        continue;
      }

      const targetLocation = classifyModuleLocation(
        resolvedImport,
        projectModulesRoot,
      );
      if (targetLocation === undefined) {
        continue;
      }

      if (sourceLocation.moduleName !== targetLocation.moduleName) {
        if (
          !isExactApplicationPublic(
            resolvedImport,
            targetLocation.moduleName,
            projectSourceRoot,
          )
        ) {
          violations.push(
            `${relativeSourcePath} crosses into ${toSourceRelativePath(resolvedImport, projectSourceRoot)}; cross-module imports must target application/public.ts`,
          );
        }
        continue;
      }

      if (sourceLocation.isCompositionRoot) {
        continue;
      }

      if (
        sourceLocation.layer === undefined ||
        targetLocation.layer === undefined ||
        !allowedSameModuleDependencies[sourceLocation.layer].has(
          targetLocation.layer,
        )
      ) {
        violations.push(
          `${relativeSourcePath} may not depend on ${toSourceRelativePath(resolvedImport, projectSourceRoot)}`,
        );
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
