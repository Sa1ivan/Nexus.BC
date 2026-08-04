import path from 'node:path';
import ts from 'typescript';
import type {
  OriginResolver,
  RestrictedOrigin,
} from '../types/architecture.types';
import {
  collectImportLikeDependencies,
  importTypeBindingName,
} from './import-like-dependencies';
import { canonicalPath, resolveImport } from './module-paths';
import {
  addOrigins,
  enclosingModuleSpecifier,
  isPrismaServiceLikeName,
  referencedExportName,
  restrictedOriginsForSpecifier,
  sourceFileOrigin,
} from './restricted-origin';
import {
  collectDeclarationTypeOrigins,
  collectTypeNodeOrigins,
} from './restricted-type-origin';

interface OriginContext {
  readonly nonCacheableExports: Set<string>;
  readonly nonCacheableSymbols: Set<ts.Symbol>;
  readonly seenExports: Set<string>;
  readonly seenSymbols: Set<ts.Symbol>;
}

function createContext(): OriginContext {
  return {
    nonCacheableExports: new Set(),
    nonCacheableSymbols: new Set(),
    seenExports: new Set(),
    seenSymbols: new Set(),
  };
}

export function createOriginResolver(
  program: ts.Program,
  compilerOptions: ts.CompilerOptions,
  sourceRoot: string,
): OriginResolver {
  return {
    checker: program.getTypeChecker(),
    compilerOptions,
    exportOriginCache: new Map(),
    program,
    sourceRoot,
    symbolOriginCache: new Map(),
  };
}

function markActiveOriginsNonCacheable(context: OriginContext): void {
  for (const cacheKey of context.seenExports) {
    context.nonCacheableExports.add(cacheKey);
  }
  for (const symbol of context.seenSymbols) {
    context.nonCacheableSymbols.add(symbol);
  }
}

function isWithinSourceRoot(fileName: string, sourceRoot: string): boolean {
  const relativePath = path.relative(
    canonicalPath(sourceRoot),
    canonicalPath(fileName),
  );
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function collectGeneratedSourceOrigins(
  entrySourceFile: ts.SourceFile,
  resolver: OriginResolver,
): ReadonlySet<RestrictedOrigin> {
  const origins = new Set<RestrictedOrigin>();
  const seenFiles = new Set<string>();

  const visit = (sourceFile: ts.SourceFile): void => {
    const sourceFileKey = canonicalPath(sourceFile.fileName);
    if (seenFiles.has(sourceFileKey)) {
      return;
    }
    seenFiles.add(sourceFileKey);

    const ownOrigin = sourceFileOrigin(
      sourceFile.fileName,
      resolver.sourceRoot,
    );
    if (ownOrigin !== undefined) {
      origins.add(ownOrigin);
    }

    for (const dependency of collectImportLikeDependencies(
      sourceFile,
      resolver.checker,
    )) {
      addOrigins(origins, restrictedOriginsForSpecifier(dependency.specifier));
      const resolvedFileName = resolveImport(
        dependency.specifier,
        sourceFile.fileName,
        resolver.compilerOptions,
      );
      if (resolvedFileName === undefined) {
        continue;
      }
      const resolvedOrigin = sourceFileOrigin(
        resolvedFileName,
        resolver.sourceRoot,
      );
      if (resolvedOrigin !== undefined) {
        origins.add(resolvedOrigin);
      }
      if (!isWithinSourceRoot(resolvedFileName, resolver.sourceRoot)) {
        continue;
      }
      const target =
        resolver.program.getSourceFile(resolvedFileName) ??
        resolver.program
          .getSourceFiles()
          .find(
            (candidate) =>
              canonicalPath(candidate.fileName) === resolvedFileName,
          );
      if (target !== undefined) {
        visit(target);
      }
    }
  };

  visit(entrySourceFile);
  return origins;
}

export function resolveLocalSourceFile(
  specifier: string,
  containingFile: string,
  resolver: OriginResolver,
): ts.SourceFile | undefined {
  const resolvedFileName = resolveImport(
    specifier,
    containingFile,
    resolver.compilerOptions,
  );
  if (
    resolvedFileName === undefined ||
    !isWithinSourceRoot(resolvedFileName, resolver.sourceRoot)
  ) {
    return undefined;
  }
  return (
    resolver.program.getSourceFile(resolvedFileName) ??
    resolver.program
      .getSourceFiles()
      .find(
        (sourceFile) => canonicalPath(sourceFile.fileName) === resolvedFileName,
      )
  );
}

function originsForExpression(
  expression: ts.Expression,
  resolver: OriginResolver,
  context: OriginContext,
): ReadonlySet<RestrictedOrigin> {
  const origins = new Set<RestrictedOrigin>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = resolver.checker.getSymbolAtLocation(node);
      if (symbol !== undefined) {
        addOrigins(
          origins,
          originsForSymbolInternal(symbol, resolver, context),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return origins;
}

function originsForSymbolInternal(
  symbol: ts.Symbol,
  resolver: OriginResolver,
  context: OriginContext,
): ReadonlySet<RestrictedOrigin> {
  const cached = resolver.symbolOriginCache.get(symbol);
  if (cached !== undefined) {
    return cached;
  }
  if (context.seenSymbols.has(symbol)) {
    markActiveOriginsNonCacheable(context);
    return new Set();
  }
  context.seenSymbols.add(symbol);
  const origins = new Set<RestrictedOrigin>();
  if (isPrismaServiceLikeName(symbol.getName())) {
    origins.add('prisma-service');
  }

  for (const declaration of symbol.getDeclarations() ?? []) {
    const fileOrigin = sourceFileOrigin(
      declaration.getSourceFile().fileName,
      resolver.sourceRoot,
    );
    if (fileOrigin !== undefined) {
      origins.add(fileOrigin);
      if (
        fileOrigin === 'prisma' &&
        isWithinSourceRoot(
          declaration.getSourceFile().fileName,
          resolver.sourceRoot,
        )
      ) {
        addOrigins(
          origins,
          collectGeneratedSourceOrigins(declaration.getSourceFile(), resolver),
        );
        continue;
      }
    }
    const specifier = enclosingModuleSpecifier(declaration);
    if (specifier !== undefined) {
      addOrigins(origins, restrictedOriginsForSpecifier(specifier));
      const targetSourceFile = resolveLocalSourceFile(
        specifier,
        declaration.getSourceFile().fileName,
        resolver,
      );
      const exportName = referencedExportName(declaration);
      if (targetSourceFile !== undefined && exportName !== undefined) {
        addOrigins(
          origins,
          originsForExportInternal(
            targetSourceFile,
            exportName,
            resolver,
            context,
          ),
        );
      }
    }
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined
    ) {
      addOrigins(
        origins,
        originsForExpression(declaration.initializer, resolver, context),
      );
    }
    addOrigins(
      origins,
      collectDeclarationTypeOrigins(
        declaration,
        resolver,
        (referencedSymbol) =>
          originsForSymbolInternal(referencedSymbol, resolver, context),
        (sourceFile, exportName) =>
          originsForExportInternal(sourceFile, exportName, resolver, context),
      ),
    );
  }

  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const aliasedSymbol = resolver.checker.getAliasedSymbol(symbol);
    if (aliasedSymbol !== symbol) {
      addOrigins(
        origins,
        originsForSymbolInternal(aliasedSymbol, resolver, context),
      );
    }
  }
  context.seenSymbols.delete(symbol);
  if (!context.nonCacheableSymbols.has(symbol)) {
    resolver.symbolOriginCache.set(symbol, new Set(origins));
  }
  return origins;
}

export function originsForSymbol(
  symbol: ts.Symbol,
  resolver: OriginResolver,
): ReadonlySet<RestrictedOrigin> {
  return originsForSymbolInternal(symbol, resolver, createContext());
}

export function restrictedImportTypeBinding(
  node: ts.ImportTypeNode,
  resolver: OriginResolver,
): { name: string; origins: ReadonlySet<RestrictedOrigin> } | undefined {
  const context = createContext();
  const origins = collectTypeNodeOrigins(
    node,
    resolver,
    (symbol) => originsForSymbolInternal(symbol, resolver, context),
    (sourceFile, exportName) =>
      originsForExportInternal(sourceFile, exportName, resolver, context),
  );
  return origins.size === 0
    ? undefined
    : {
        name: importTypeBindingName(node, node.getSourceFile()),
        origins,
      };
}

function originsForExportDeclaration(
  declaration: ts.ExportDeclaration,
  exportName: string,
  resolver: OriginResolver,
  context: OriginContext,
): ReadonlySet<RestrictedOrigin> {
  const origins = new Set<RestrictedOrigin>();
  const specifier =
    declaration.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(declaration.moduleSpecifier)
      ? declaration.moduleSpecifier.text
      : undefined;
  const targetSourceFile =
    specifier === undefined
      ? undefined
      : resolveLocalSourceFile(
          specifier,
          declaration.getSourceFile().fileName,
          resolver,
        );

  if (declaration.exportClause === undefined) {
    if (specifier !== undefined) {
      addOrigins(origins, restrictedOriginsForSpecifier(specifier));
    }
    if (targetSourceFile !== undefined) {
      addOrigins(
        origins,
        originsForExportInternal(
          targetSourceFile,
          exportName,
          resolver,
          context,
        ),
      );
    }
    return origins;
  }
  if (ts.isNamespaceExport(declaration.exportClause)) {
    if (
      exportName === '*' ||
      exportName === declaration.exportClause.name.text
    ) {
      if (specifier !== undefined) {
        addOrigins(origins, restrictedOriginsForSpecifier(specifier));
      }
      if (targetSourceFile !== undefined) {
        addOrigins(
          origins,
          originsForExportInternal(targetSourceFile, '*', resolver, context),
        );
      }
    }
    return origins;
  }

  for (const element of declaration.exportClause.elements) {
    if (exportName !== '*' && exportName !== element.name.text) {
      continue;
    }
    const sourceName = (element.propertyName ?? element.name).text;
    if (specifier !== undefined) {
      addOrigins(origins, restrictedOriginsForSpecifier(specifier));
    }
    if (targetSourceFile !== undefined) {
      addOrigins(
        origins,
        originsForExportInternal(
          targetSourceFile,
          sourceName,
          resolver,
          context,
        ),
      );
    } else if (specifier === undefined) {
      const symbol = resolver.checker.getSymbolAtLocation(
        element.propertyName ?? element.name,
      );
      if (symbol !== undefined) {
        addOrigins(
          origins,
          originsForSymbolInternal(symbol, resolver, context),
        );
      }
    }
  }
  return origins;
}

function originsForExportInternal(
  sourceFile: ts.SourceFile,
  exportName: string,
  resolver: OriginResolver,
  context: OriginContext,
): ReadonlySet<RestrictedOrigin> {
  const cacheKey = `${canonicalPath(sourceFile.fileName)}::${exportName}`;
  const cached = resolver.exportOriginCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  if (context.seenExports.has(cacheKey)) {
    markActiveOriginsNonCacheable(context);
    return new Set();
  }
  context.seenExports.add(cacheKey);
  const origins = new Set<RestrictedOrigin>();
  const moduleSymbol = resolver.checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol !== undefined) {
    for (const exportedSymbol of resolver.checker.getExportsOfModule(
      moduleSymbol,
    )) {
      if (exportName === '*' || exportName === exportedSymbol.getName()) {
        addOrigins(
          origins,
          originsForSymbolInternal(exportedSymbol, resolver, context),
        );
      }
    }
  }
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      addOrigins(
        origins,
        originsForExportDeclaration(statement, exportName, resolver, context),
      );
    } else if (
      ts.isExportAssignment(statement) &&
      (exportName === '*' || exportName === 'default')
    ) {
      addOrigins(
        origins,
        originsForExpression(statement.expression, resolver, context),
      );
    }
  }
  context.seenExports.delete(cacheKey);
  if (!context.nonCacheableExports.has(cacheKey)) {
    resolver.exportOriginCache.set(cacheKey, new Set(origins));
  }
  return origins;
}

export function originsForExport(
  sourceFile: ts.SourceFile,
  exportName: string,
  resolver: OriginResolver,
): ReadonlySet<RestrictedOrigin> {
  return originsForExportInternal(
    sourceFile,
    exportName,
    resolver,
    createContext(),
  );
}
