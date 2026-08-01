import path from 'node:path';
import ts from 'typescript';
import type {
  OriginResolver,
  RestrictedOrigin,
} from '../types/architecture.types';
import { canonicalPath, resolveImport } from './module-paths';
import { addOrigins, restrictedOriginsForSpecifier } from './restricted-origin';

type SymbolOriginLookup = (
  symbol: ts.Symbol,
  resolver: OriginResolver,
) => ReadonlySet<RestrictedOrigin>;

type ExportOriginLookup = (
  sourceFile: ts.SourceFile,
  exportName: string,
  resolver: OriginResolver,
) => ReadonlySet<RestrictedOrigin>;

function resolveLocalSourceFile(
  specifier: string,
  containingFile: string,
  resolver: OriginResolver,
): ts.SourceFile | undefined {
  const resolved = resolveImport(
    specifier,
    containingFile,
    resolver.compilerOptions,
  );
  if (resolved === undefined) {
    return undefined;
  }
  const relativePath = path.relative(
    canonicalPath(resolver.sourceRoot),
    resolved,
  );
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return undefined;
  }
  return (
    resolver.program.getSourceFile(resolved) ??
    resolver.program
      .getSourceFiles()
      .find((sourceFile) => canonicalPath(sourceFile.fileName) === resolved)
  );
}

function qualifierParts(qualifier: ts.EntityName | undefined): string[] {
  if (qualifier === undefined) {
    return [];
  }
  if (ts.isIdentifier(qualifier)) {
    return [qualifier.text];
  }
  return [...qualifierParts(qualifier.left), qualifier.right.text];
}

function originsForQualifiedExport(
  sourceFile: ts.SourceFile,
  exportPath: readonly string[],
  resolver: OriginResolver,
  lookupExportOrigins: ExportOriginLookup,
  seen = new Set<string>(),
): ReadonlySet<RestrictedOrigin> {
  if (exportPath.length <= 1) {
    return lookupExportOrigins(sourceFile, exportPath[0] ?? '*', resolver);
  }
  const cacheKey = `${sourceFile.fileName}::${exportPath.join('.')}`;
  if (seen.has(cacheKey)) {
    return new Set();
  }
  seen.add(cacheKey);
  const origins = new Set<RestrictedOrigin>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      statement.exportClause === undefined ||
      !ts.isNamespaceExport(statement.exportClause) ||
      statement.exportClause.name.text !== exportPath[0]
    ) {
      continue;
    }
    addOrigins(
      origins,
      restrictedOriginsForSpecifier(statement.moduleSpecifier.text),
    );
    const target = resolveLocalSourceFile(
      statement.moduleSpecifier.text,
      sourceFile.fileName,
      resolver,
    );
    if (target !== undefined) {
      addOrigins(
        origins,
        originsForQualifiedExport(
          target,
          exportPath.slice(1),
          resolver,
          lookupExportOrigins,
          seen,
        ),
      );
    }
  }
  return origins;
}

export function collectTypeNodeOrigins(
  typeNode: ts.Node,
  resolver: OriginResolver,
  lookupSymbolOrigins: SymbolOriginLookup,
  lookupExportOrigins: ExportOriginLookup,
): ReadonlySet<RestrictedOrigin> {
  const origins = new Set<RestrictedOrigin>();

  const visit = (node: ts.Node): void => {
    if (ts.isImportTypeNode(node)) {
      const specifier =
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
          ? node.argument.literal.text
          : undefined;
      if (specifier !== undefined) {
        addOrigins(origins, restrictedOriginsForSpecifier(specifier));
        const target = resolveLocalSourceFile(
          specifier,
          node.getSourceFile().fileName,
          resolver,
        );
        if (target !== undefined) {
          addOrigins(
            origins,
            originsForQualifiedExport(
              target,
              qualifierParts(node.qualifier),
              resolver,
              lookupExportOrigins,
            ),
          );
        }
      }
      return;
    }
    if (ts.isIdentifier(node)) {
      const symbol = resolver.checker.getSymbolAtLocation(node);
      if (symbol !== undefined) {
        addOrigins(origins, lookupSymbolOrigins(symbol, resolver));
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(typeNode);
  return origins;
}

export function collectDeclarationTypeOrigins(
  declaration: ts.Declaration,
  resolver: OriginResolver,
  lookupSymbolOrigins: SymbolOriginLookup,
  lookupExportOrigins: ExportOriginLookup,
): ReadonlySet<RestrictedOrigin> {
  const origins = new Set<RestrictedOrigin>();
  const addNode = (node: ts.Node | undefined): void => {
    if (node !== undefined) {
      addOrigins(
        origins,
        collectTypeNodeOrigins(
          node,
          resolver,
          lookupSymbolOrigins,
          lookupExportOrigins,
        ),
      );
    }
  };
  const addTypeParameters = (
    typeParameters: readonly ts.TypeParameterDeclaration[] | undefined,
  ): void => {
    for (const typeParameter of typeParameters ?? []) {
      addNode(typeParameter.constraint);
      addNode(typeParameter.default);
    }
  };
  const addParameters = (
    parameters: readonly ts.ParameterDeclaration[],
  ): void => {
    for (const parameter of parameters) {
      addNode(parameter.type);
    }
  };

  if (ts.isTypeAliasDeclaration(declaration)) {
    addTypeParameters(declaration.typeParameters);
    addNode(declaration.type);
  } else if (ts.isInterfaceDeclaration(declaration)) {
    addTypeParameters(declaration.typeParameters);
    for (const heritageClause of declaration.heritageClauses ?? []) {
      addNode(heritageClause);
    }
    for (const member of declaration.members) {
      addOrigins(
        origins,
        collectDeclarationTypeOrigins(
          member,
          resolver,
          lookupSymbolOrigins,
          lookupExportOrigins,
        ),
      );
    }
  } else if (ts.isClassDeclaration(declaration)) {
    addTypeParameters(declaration.typeParameters);
    for (const heritageClause of declaration.heritageClauses ?? []) {
      addNode(heritageClause);
    }
    for (const member of declaration.members) {
      addOrigins(
        origins,
        collectDeclarationTypeOrigins(
          member,
          resolver,
          lookupSymbolOrigins,
          lookupExportOrigins,
        ),
      );
    }
  } else if (ts.isFunctionLike(declaration)) {
    addTypeParameters(declaration.typeParameters);
    addParameters(declaration.parameters);
    addNode(declaration.type);
  } else if (
    ts.isPropertyDeclaration(declaration) ||
    ts.isPropertySignature(declaration) ||
    ts.isVariableDeclaration(declaration)
  ) {
    addNode(declaration.type);
  } else if (ts.isIndexSignatureDeclaration(declaration)) {
    addParameters(declaration.parameters);
    addNode(declaration.type);
  } else if (ts.isTypeParameterDeclaration(declaration)) {
    addNode(declaration.constraint);
    addNode(declaration.default);
  }

  return origins;
}
