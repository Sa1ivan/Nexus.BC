import ts from 'typescript';
import type {
  OriginResolver,
  RestrictedOrigin,
} from '../types/architecture.types';
import { resolveImport } from './module-paths';
import {
  addOrigins,
  enclosingModuleSpecifier,
  isPrismaServiceLikeName,
  referencedExportName,
  restrictedOriginsForSpecifier,
  sourceFileOrigin,
} from './restricted-origin';

export function createOriginResolver(
  program: ts.Program,
  compilerOptions: ts.CompilerOptions,
  sourceRoot: string,
): OriginResolver {
  return {
    checker: program.getTypeChecker(),
    compilerOptions,
    exportCache: new Map(),
    exportsInProgress: new Set(),
    program,
    sourceRoot,
    symbolCache: new Map(),
    symbolsInProgress: new Set(),
  };
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
  if (resolvedFileName === undefined) {
    return undefined;
  }

  const relativePath = ts.sys
    .resolvePath(resolvedFileName)
    .slice(ts.sys.resolvePath(resolver.sourceRoot).length);
  if (!relativePath.startsWith('/') && !relativePath.startsWith('\\')) {
    return undefined;
  }

  return resolver.program.getSourceFile(resolvedFileName);
}

function originsForExpression(
  expression: ts.Expression,
  resolver: OriginResolver,
): ReadonlySet<RestrictedOrigin> {
  const origins = new Set<RestrictedOrigin>();

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = resolver.checker.getSymbolAtLocation(node);
      if (symbol !== undefined) {
        addOrigins(origins, originsForSymbol(symbol, resolver));
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(expression);
  return origins;
}

export function originsForSymbol(
  symbol: ts.Symbol,
  resolver: OriginResolver,
): ReadonlySet<RestrictedOrigin> {
  const cached = resolver.symbolCache.get(symbol);
  if (cached !== undefined) {
    return cached;
  }
  if (resolver.symbolsInProgress.has(symbol)) {
    return new Set();
  }

  resolver.symbolsInProgress.add(symbol);
  const origins = new Set<RestrictedOrigin>();

  if (isPrismaServiceLikeName(symbol.getName())) {
    origins.add('prisma-service');
  }

  for (const declaration of symbol.getDeclarations() ?? []) {
    const fileOrigin = sourceFileOrigin(declaration.getSourceFile().fileName);
    if (fileOrigin !== undefined) {
      origins.add(fileOrigin);
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
          originsForExport(targetSourceFile, exportName, resolver),
        );
      }
    }

    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined
    ) {
      addOrigins(
        origins,
        originsForExpression(declaration.initializer, resolver),
      );
    }
  }

  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const aliasedSymbol = resolver.checker.getAliasedSymbol(symbol);
    if (aliasedSymbol !== symbol) {
      addOrigins(origins, originsForSymbol(aliasedSymbol, resolver));
    }
  }

  resolver.symbolsInProgress.delete(symbol);
  resolver.symbolCache.set(symbol, origins);
  return origins;
}

function originsForExportDeclaration(
  declaration: ts.ExportDeclaration,
  exportName: string,
  resolver: OriginResolver,
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
        originsForExport(targetSourceFile, exportName, resolver),
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
        addOrigins(origins, originsForExport(targetSourceFile, '*', resolver));
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
        originsForExport(targetSourceFile, sourceName, resolver),
      );
    } else if (specifier === undefined) {
      const symbol = resolver.checker.getSymbolAtLocation(
        element.propertyName ?? element.name,
      );
      if (symbol !== undefined) {
        addOrigins(origins, originsForSymbol(symbol, resolver));
      }
    }
  }

  return origins;
}

export function originsForExport(
  sourceFile: ts.SourceFile,
  exportName: string,
  resolver: OriginResolver,
): ReadonlySet<RestrictedOrigin> {
  const cacheKey = `${sourceFile.fileName}::${exportName}`;
  const cached = resolver.exportCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  if (resolver.exportsInProgress.has(cacheKey)) {
    return new Set();
  }

  resolver.exportsInProgress.add(cacheKey);
  const origins = new Set<RestrictedOrigin>();
  const moduleSymbol = resolver.checker.getSymbolAtLocation(sourceFile);

  if (moduleSymbol !== undefined) {
    for (const exportedSymbol of resolver.checker.getExportsOfModule(
      moduleSymbol,
    )) {
      if (exportName === '*' || exportName === exportedSymbol.getName()) {
        addOrigins(origins, originsForSymbol(exportedSymbol, resolver));
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      addOrigins(
        origins,
        originsForExportDeclaration(statement, exportName, resolver),
      );
    } else if (
      ts.isExportAssignment(statement) &&
      (exportName === '*' || exportName === 'default')
    ) {
      addOrigins(origins, originsForExpression(statement.expression, resolver));
    }
  }

  resolver.exportsInProgress.delete(cacheKey);
  resolver.exportCache.set(cacheKey, origins);
  return origins;
}

export function referencesPrismaServiceLikeSymbol(
  sourceFile: ts.SourceFile,
): boolean {
  let found = false;

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isPrismaServiceLikeName(node.text)) {
      found = true;
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}
