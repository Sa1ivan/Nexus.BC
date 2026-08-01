import path from 'node:path';
import ts from 'typescript';
import {
  enclosingModuleSpecifier,
  referencedExportName,
} from './restricted-origin';

export function decoratorExpressionSymbol(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  return checker.getSymbolAtLocation(
    ts.isPropertyAccessExpression(expression) ? expression.name : expression,
  );
}

export function isNestCommonNamespaceExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return isNestCommonNamespaceExpression(
      expression.expression,
      checker,
      seen,
    );
  }
  const symbol = checker.getSymbolAtLocation(expression);
  if (symbol === undefined || seen.has(symbol)) {
    return false;
  }
  seen.add(symbol);
  for (const declaration of symbol.getDeclarations() ?? []) {
    if (ts.isNamespaceImport(declaration)) {
      const importDeclaration = declaration.parent.parent;
      if (
        ts.isImportDeclaration(importDeclaration) &&
        ts.isStringLiteralLike(importDeclaration.moduleSpecifier) &&
        importDeclaration.moduleSpecifier.text === '@nestjs/common'
      ) {
        return true;
      }
    }
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      isNestCommonNamespaceExpression(declaration.initializer, checker, seen)
    ) {
      return true;
    }
  }
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const aliased = checker.getAliasedSymbol(symbol);
    return (
      aliased !== symbol &&
      (aliased.getDeclarations() ?? []).some(ts.isNamespaceImport)
    );
  }
  return false;
}

function isNestApplyDecoratorsSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): boolean {
  if (seen.has(symbol)) {
    return false;
  }
  seen.add(symbol);
  for (const declaration of symbol.getDeclarations() ?? []) {
    if (
      enclosingModuleSpecifier(declaration) === '@nestjs/common' &&
      referencedExportName(declaration) === 'applyDecorators'
    ) {
      return true;
    }
    const normalizedFileName = declaration
      .getSourceFile()
      .fileName.split(path.sep)
      .join('/');
    if (
      symbol.getName() === 'applyDecorators' &&
      normalizedFileName.includes('/node_modules/@nestjs/common/')
    ) {
      return true;
    }
  }
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const aliased = checker.getAliasedSymbol(symbol);
    if (
      aliased !== symbol &&
      isNestApplyDecoratorsSymbol(aliased, checker, seen)
    ) {
      return true;
    }
  }
  return false;
}

export function isNestApplyDecoratorsCall(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): boolean {
  const symbol = decoratorExpressionSymbol(expression.expression, checker);
  return (
    symbol !== undefined &&
    isNestApplyDecoratorsSymbol(symbol, checker, new Set())
  );
}
