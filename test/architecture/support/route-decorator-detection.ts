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

const routeDecoratorNames = new Set([
  'All',
  'Delete',
  'Get',
  'Head',
  'Options',
  'Patch',
  'Post',
  'Put',
  'Sse',
]);

function enclosingModuleSymbol(
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  let current: ts.Node | undefined = declaration;
  while (current !== undefined) {
    if (
      (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) &&
      current.moduleSpecifier !== undefined
    ) {
      return checker.getSymbolAtLocation(current.moduleSpecifier);
    }
    current = current.parent;
  }
  return undefined;
}

function isNestRouteNamespaceAccess(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  if (
    !ts.isPropertyAccessExpression(expression) ||
    !routeDecoratorNames.has(expression.name.text)
  ) {
    return false;
  }
  return isNestCommonNamespaceExpression(expression.expression, checker);
}

function expressionReturnsNestRoute(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return expressionReturnsNestRoute(expression.expression, checker, seen);
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return expressionReturnsNestRoute(expression.expression, checker, seen);
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      expressionReturnsNestRoute(expression.whenTrue, checker, seen) ||
      expressionReturnsNestRoute(expression.whenFalse, checker, seen)
    );
  }
  if (ts.isCallExpression(expression)) {
    if (isNestRouteNamespaceAccess(expression.expression, checker)) {
      return true;
    }
    if (
      isNestApplyDecoratorsCall(expression, checker) &&
      expression.arguments.some((argument) =>
        expressionReturnsNestRoute(
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
      expressionReturnsNestRoute(expression.expression, checker, seen)
    ) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === 'bind' &&
      expressionReturnsNestRoute(
        expression.expression.expression,
        checker,
        seen,
      )
    ) {
      return true;
    }
    const symbol = decoratorExpressionSymbol(expression.expression, checker);
    return (
      symbol !== undefined && isNestRouteDecoratorSymbol(symbol, checker, seen)
    );
  }
  if (isNestRouteNamespaceAccess(expression, checker)) {
    return true;
  }
  const symbol = decoratorExpressionSymbol(expression, checker);
  return (
    symbol !== undefined && isNestRouteDecoratorSymbol(symbol, checker, seen)
  );
}

function bodyReturnsNestRoute(
  body: ts.ConciseBody | ts.Block,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): boolean {
  if (!ts.isBlock(body)) {
    return expressionReturnsNestRoute(body, checker, seen);
  }
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionLike(node) || ts.isClassLike(node)) {
      return;
    }
    if (
      ts.isReturnStatement(node) &&
      node.expression !== undefined &&
      expressionReturnsNestRoute(node.expression, checker, seen)
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

function enclosingVariableDeclaration(
  binding: ts.BindingElement,
): ts.VariableDeclaration | undefined {
  let current: ts.Node | undefined = binding.parent;
  while (current !== undefined && !ts.isVariableDeclaration(current)) {
    current = current.parent;
  }
  return current;
}

function bindingReturnsNestRoute(
  binding: ts.BindingElement,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): boolean {
  const variable = enclosingVariableDeclaration(binding);
  const initializer = variable?.initializer;
  if (initializer === undefined) {
    return false;
  }
  if (ts.isObjectBindingPattern(binding.parent)) {
    const propertyName = binding.propertyName ?? binding.name;
    const name =
      ts.isIdentifier(propertyName) ||
      ts.isStringLiteralLike(propertyName) ||
      ts.isNumericLiteral(propertyName)
        ? propertyName.text
        : propertyName.getText(binding.getSourceFile());
    if (
      routeDecoratorNames.has(name) &&
      isNestCommonNamespaceExpression(initializer, checker)
    ) {
      return true;
    }
    const property = checker.getTypeAtLocation(initializer).getProperty(name);
    return (
      property !== undefined &&
      isNestRouteDecoratorSymbol(property, checker, seen)
    );
  }
  if (
    ts.isArrayBindingPattern(binding.parent) &&
    ts.isArrayLiteralExpression(initializer)
  ) {
    const index = binding.parent.elements.indexOf(binding);
    const element = initializer.elements[index];
    return (
      element !== undefined &&
      !ts.isOmittedExpression(element) &&
      expressionReturnsNestRoute(element, checker, seen)
    );
  }
  return false;
}

function isNestRouteDecoratorSymbol(
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
    const exportName = referencedExportName(declaration);
    if (
      specifier === '@nestjs/common' &&
      exportName !== undefined &&
      routeDecoratorNames.has(exportName)
    ) {
      return true;
    }
    const moduleSymbol = enclosingModuleSymbol(declaration, checker);
    if (moduleSymbol !== undefined && exportName !== undefined) {
      const exported = checker
        .getExportsOfModule(moduleSymbol)
        .find((candidate) => candidate.getName() === exportName);
      if (
        exported !== undefined &&
        exported !== symbol &&
        isNestRouteDecoratorSymbol(exported, checker, seen)
      ) {
        return true;
      }
    }
    const normalizedFileName = declaration
      .getSourceFile()
      .fileName.split(path.sep)
      .join('/');
    const declarationName =
      ts.isFunctionDeclaration(declaration) && declaration.name !== undefined
        ? declaration.name.text
        : symbol.getName();
    if (
      routeDecoratorNames.has(declarationName) &&
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
        if (bodyReturnsNestRoute(declaration.initializer.body, checker, seen)) {
          return true;
        }
      } else if (
        expressionReturnsNestRoute(declaration.initializer, checker, seen)
      ) {
        return true;
      }
    }
    if (
      ts.isPropertyAssignment(declaration) &&
      expressionReturnsNestRoute(declaration.initializer, checker, seen)
    ) {
      return true;
    }
    if (ts.isShorthandPropertyAssignment(declaration)) {
      const valueSymbol =
        checker.getShorthandAssignmentValueSymbol(declaration);
      if (
        valueSymbol !== undefined &&
        isNestRouteDecoratorSymbol(valueSymbol, checker, seen)
      ) {
        return true;
      }
    }
    if (
      ts.isBindingElement(declaration) &&
      bindingReturnsNestRoute(declaration, checker, seen)
    ) {
      return true;
    }
    if (
      ts.isFunctionDeclaration(declaration) &&
      declaration.body !== undefined &&
      bodyReturnsNestRoute(declaration.body, checker, seen)
    ) {
      return true;
    }
  }
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const aliased = checker.getAliasedSymbol(symbol);
    if (
      aliased !== symbol &&
      isNestRouteDecoratorSymbol(aliased, checker, seen)
    ) {
      return true;
    }
  }
  return false;
}

export function isNestRouteMethod(
  method: ts.MethodDeclaration,
  checker: ts.TypeChecker,
): boolean {
  return (
    (ts.canHaveDecorators(method) ? ts.getDecorators(method) : undefined) ?? []
  ).some((decorator) =>
    expressionReturnsNestRoute(decorator.expression, checker, new Set()),
  );
}
