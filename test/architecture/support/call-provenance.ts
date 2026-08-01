import ts from 'typescript';

export function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function expressionSymbol(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    return checker.getSymbolAtLocation(current.name);
  }
  if (ts.isElementAccessExpression(current)) {
    return checker.getSymbolAtLocation(current.argumentExpression);
  }
  return checker.getSymbolAtLocation(current);
}

function isUnshadowedGlobalReflect(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const receiver = unwrapExpression(expression);
  if (!ts.isIdentifier(receiver) || receiver.text !== 'Reflect') {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(receiver);
  return (symbol?.getDeclarations() ?? []).some(
    (declaration) =>
      declaration.getSourceFile().fileName.split(/[\\/]/u).at(-1) ===
      'lib.es2015.reflect.d.ts',
  );
}

export function reflectedCallableTarget(
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): ts.Expression | undefined {
  const callee = unwrapExpression(call.expression);
  if (
    !ts.isPropertyAccessExpression(callee) ||
    (callee.name.text !== 'apply' && callee.name.text !== 'construct') ||
    !isUnshadowedGlobalReflect(callee.expression, checker)
  ) {
    return undefined;
  }
  return call.arguments[0];
}
