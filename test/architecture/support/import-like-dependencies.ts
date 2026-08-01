import ts from 'typescript';
import type {
  ImportLikeDependency,
  ImportLikeOperation,
} from '../types/architecture.types';

export function isCommonJsRequireCall(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): boolean {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'require') {
    return false;
  }

  const symbol = checker.getSymbolAtLocation(node.expression);
  return !symbol
    ?.getDeclarations()
    ?.some((declaration) => declaration.getSourceFile() === sourceFile);
}

export function collectImportLikeSpecifiers(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): string[] {
  return collectImportLikeDependencies(sourceFile, checker).map(
    ({ specifier }) => specifier,
  );
}

function importTypeSpecifier(node: ts.ImportTypeNode): string | undefined {
  return ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteralLike(node.argument.literal)
    ? node.argument.literal.text
    : undefined;
}

function importTypeExportName(
  qualifier: ts.EntityName | undefined,
  sourceFile: ts.SourceFile,
): string {
  return qualifier?.getText(sourceFile) ?? '*';
}

export function importTypeBindingName(
  node: ts.ImportTypeNode,
  sourceFile: ts.SourceFile,
): string {
  const specifier = importTypeSpecifier(node) ?? '<non-literal>';
  const qualifier = node.qualifier?.getText(sourceFile);
  return `import("${specifier}")${qualifier === undefined ? '' : `.${qualifier}`}`;
}

export function collectImportLikeDependencies(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): ImportLikeDependency[] {
  const dependencies: ImportLikeDependency[] = [];

  const add = (specifier: string, exportName: string): void => {
    dependencies.push({ exportName, specifier });
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause === undefined) {
        add(specifier, '*');
      } else {
        if (clause.name !== undefined) {
          add(specifier, 'default');
        }
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          add(specifier, '*');
        } else {
          for (const element of bindings?.elements ?? []) {
            add(specifier, (element.propertyName ?? element.name).text);
          }
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      if (
        node.exportClause === undefined ||
        ts.isNamespaceExport(node.exportClause)
      ) {
        add(specifier, '*');
      } else {
        for (const element of node.exportClause.elements) {
          add(specifier, (element.propertyName ?? element.name).text);
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression.text, '*');
    } else if (ts.isImportTypeNode(node)) {
      const specifier = importTypeSpecifier(node);
      if (specifier !== undefined) {
        add(specifier, importTypeExportName(node.qualifier, sourceFile));
      }
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        isCommonJsRequireCall(node, checker, sourceFile))
    ) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        add(argument.text, '*');
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return dependencies;
}

export function collectUnverifiableImportLikes(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): ImportLikeOperation[] {
  const operations: ImportLikeOperation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const operation = importLikeOperation(node, checker, sourceFile);
      const argument = node.arguments[0];
      if (
        operation !== undefined &&
        (argument === undefined || !ts.isStringLiteralLike(argument))
      ) {
        operations.push(operation);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return operations;
}

function importLikeOperation(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): ImportLikeOperation | undefined {
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return 'import';
  }
  if (isCommonJsRequireCall(node, checker, sourceFile)) {
    return 'require';
  }

  return undefined;
}
