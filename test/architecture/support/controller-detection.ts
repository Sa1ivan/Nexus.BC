import path from 'node:path';
import ts from 'typescript';
import {
  enclosingModuleSpecifier,
  referencedExportName,
} from './restricted-origin';
import {
  decoratorExpressionSymbol,
  isNestApplyDecoratorsCall,
  isNestCommonNamespaceExpression,
} from './nest-decorator-origin';

function expressionReturnsNestController(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return expressionReturnsNestController(
      expression.expression,
      checker,
      seen,
    );
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return expressionReturnsNestController(
      expression.expression,
      checker,
      seen,
    );
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      expressionReturnsNestController(expression.whenTrue, checker, seen) ||
      expressionReturnsNestController(expression.whenFalse, checker, seen)
    );
  }
  if (ts.isCallExpression(expression)) {
    if (isNestControllerNamespaceAccess(expression.expression, checker)) {
      return true;
    }
    if (
      isNestApplyDecoratorsCall(expression, checker) &&
      expression.arguments.some((argument) =>
        expressionReturnsNestController(
          ts.isSpreadElement(argument) ? argument.expression : argument,
          checker,
          seen,
        ),
      )
    ) {
      return true;
    }
    if (
      ts.isCallExpression(expression.expression) &&
      expressionReturnsNestController(expression.expression, checker, seen)
    ) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === 'bind' &&
      expressionReturnsNestController(
        expression.expression.expression,
        checker,
        seen,
      )
    ) {
      return true;
    }
    const symbol = decoratorExpressionSymbol(expression.expression, checker);
    return (
      symbol !== undefined &&
      isNestControllerFactorySymbol(symbol, checker, seen)
    );
  }
  const symbol = decoratorExpressionSymbol(expression, checker);
  return (
    symbol !== undefined && isNestControllerFactorySymbol(symbol, checker, seen)
  );
}

function isNestControllerNamespaceAccess(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  if (
    !ts.isPropertyAccessExpression(expression) ||
    expression.name.text !== 'Controller'
  ) {
    return false;
  }
  return isNestCommonNamespaceExpression(expression.expression, checker);
}

function bodyReturnsNestController(
  body: ts.ConciseBody | ts.Block,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): boolean {
  if (!ts.isBlock(body)) {
    return expressionReturnsNestController(body, checker, seen);
  }
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node) || ts.isClassLike(node)) {
      return;
    }
    if (
      ts.isReturnStatement(node) &&
      node.expression !== undefined &&
      expressionReturnsNestController(node.expression, checker, seen)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of body.statements) {
    visit(statement);
  }
  return found;
}

function isNestControllerFactorySymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
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

    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined
    ) {
      if (
        ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer)
      ) {
        if (
          bodyReturnsNestController(declaration.initializer.body, checker, seen)
        ) {
          return true;
        }
      } else if (
        expressionReturnsNestController(declaration.initializer, checker, seen)
      ) {
        return true;
      }
    }

    if (
      ts.isFunctionDeclaration(declaration) &&
      declaration.body !== undefined &&
      bodyReturnsNestController(declaration.body, checker, seen)
    ) {
      return true;
    }
  }

  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const aliased = checker.getAliasedSymbol(symbol);
    if (
      aliased !== symbol &&
      isNestControllerFactorySymbol(aliased, checker, seen)
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
      for (const decorator of (ts.canHaveDecorators(node)
        ? ts.getDecorators(node)
        : undefined) ?? []) {
        if (
          expressionReturnsNestController(
            decorator.expression,
            checker,
            new Set(),
          )
        ) {
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

export function isControllerSourceFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): boolean {
  return (
    sourceFile.fileName.endsWith('.controller.ts') ||
    hasNestControllerDecorator(sourceFile, checker)
  );
}
