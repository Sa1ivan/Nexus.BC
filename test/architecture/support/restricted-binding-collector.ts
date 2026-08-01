import ts from 'typescript';
import type {
  OriginResolver,
  RestrictedBinding,
  RestrictedOrigin,
} from '../types/architecture.types';
import { isCommonJsRequireCall } from './import-like-dependencies';
import {
  originsForExport,
  originsForSymbol,
  resolveLocalSourceFile,
} from './restricted-origin-resolver';
import { addOrigins, restrictedOriginsForSpecifier } from './restricted-origin';

export function collectRestrictedBindings(
  sourceFile: ts.SourceFile,
  resolver: OriginResolver,
): RestrictedBinding[] {
  const bindings: RestrictedBinding[] = [];

  const addModuleBinding = (
    name: string,
    specifier: string,
    exportName: string,
  ): void => {
    const origins = new Set<RestrictedOrigin>(
      restrictedOriginsForSpecifier(specifier),
    );
    const targetSourceFile = resolveLocalSourceFile(
      specifier,
      sourceFile.fileName,
      resolver,
    );
    if (targetSourceFile !== undefined) {
      addOrigins(
        origins,
        originsForExport(targetSourceFile, exportName, resolver),
      );
    }
    if (origins.size > 0) {
      bindings.push({ name, origins });
    }
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteralLike(statement.moduleSpecifier) &&
      statement.importClause !== undefined
    ) {
      const specifier = statement.moduleSpecifier.text;
      if (statement.importClause.name !== undefined) {
        addModuleBinding(
          statement.importClause.name.text,
          specifier,
          'default',
        );
      }

      const namedBindings = statement.importClause.namedBindings;
      if (namedBindings !== undefined && ts.isNamespaceImport(namedBindings)) {
        addModuleBinding(namedBindings.name.text, specifier, '*');
      } else if (namedBindings !== undefined) {
        for (const element of namedBindings.elements) {
          addModuleBinding(
            element.name.text,
            specifier,
            (element.propertyName ?? element.name).text,
          );
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      statement.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(statement.moduleReference.expression)
    ) {
      addModuleBinding(
        statement.name.text,
        statement.moduleReference.expression.text,
        '*',
      );
    } else if (ts.isExportDeclaration(statement)) {
      collectExportBindings(statement, resolver, addModuleBinding, bindings);
    }
  }

  const visitRuntimeImports = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const isDynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = isCommonJsRequireCall(
        node,
        resolver.checker,
        sourceFile,
      );
      const argument = node.arguments[0];

      if (
        (isDynamicImport || isRequire) &&
        argument !== undefined &&
        ts.isStringLiteralLike(argument)
      ) {
        const operation = isDynamicImport ? 'import' : 'require';
        addModuleBinding(
          `${operation}("${argument.text}")`,
          argument.text,
          '*',
        );
      }
    }

    ts.forEachChild(node, visitRuntimeImports);
  };

  visitRuntimeImports(sourceFile);
  return bindings;
}

function collectExportBindings(
  declaration: ts.ExportDeclaration,
  resolver: OriginResolver,
  addModuleBinding: (
    name: string,
    specifier: string,
    exportName: string,
  ) => void,
  bindings: RestrictedBinding[],
): void {
  const specifier =
    declaration.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(declaration.moduleSpecifier)
      ? declaration.moduleSpecifier.text
      : undefined;

  if (declaration.exportClause === undefined && specifier !== undefined) {
    addModuleBinding('*', specifier, '*');
    return;
  }
  if (
    declaration.exportClause !== undefined &&
    ts.isNamespaceExport(declaration.exportClause) &&
    specifier !== undefined
  ) {
    addModuleBinding(declaration.exportClause.name.text, specifier, '*');
    return;
  }
  if (
    declaration.exportClause === undefined ||
    !ts.isNamedExports(declaration.exportClause)
  ) {
    return;
  }

  for (const element of declaration.exportClause.elements) {
    if (specifier !== undefined) {
      addModuleBinding(
        element.name.text,
        specifier,
        (element.propertyName ?? element.name).text,
      );
      continue;
    }

    const symbol = resolver.checker.getSymbolAtLocation(
      element.propertyName ?? element.name,
    );
    if (symbol === undefined) {
      continue;
    }

    const origins = originsForSymbol(symbol, resolver);
    if (origins.size > 0) {
      bindings.push({ name: element.name.text, origins });
    }
  }
}
