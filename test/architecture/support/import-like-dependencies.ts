import ts from 'typescript';
import type { ImportLikeOperation } from '../types/architecture.types';

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
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        isCommonJsRequireCall(node, checker, sourceFile))
    ) {
      const argument = node.arguments[0];
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        specifiers.push(argument.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
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
