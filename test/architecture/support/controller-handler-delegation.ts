import ts from 'typescript';
import {
  expressionSymbol,
  reflectedCallableTarget,
  unwrapExpression,
} from './call-provenance';
import { classifyModuleLocation } from './module-paths';
import { isNestRouteMethod } from './route-decorator-detection';

type DependencyOrigin = 'application' | 'external' | 'other-project-layer';

interface ProjectDependency {
  readonly key: string;
  readonly name: string;
  readonly origin: Exclude<DependencyOrigin, 'external'>;
}

function declarationOrigin(
  declarations: readonly ts.Declaration[],
  moduleName: string,
  projectModulesRoot: string,
): DependencyOrigin {
  const projectLocations = declarations
    .map((declaration) =>
      classifyModuleLocation(
        declaration.getSourceFile().fileName,
        projectModulesRoot,
      ),
    )
    .filter((location) => location !== undefined);
  if (projectLocations.length === 0) {
    return 'external';
  }
  return projectLocations.every(
    (location) =>
      location.moduleName === moduleName && location.layer === 'application',
  )
    ? 'application'
    : 'other-project-layer';
}

function typeOrigin(
  type: ts.Type,
  moduleName: string,
  projectModulesRoot: string,
): DependencyOrigin {
  return declarationOrigin(
    (type.aliasSymbol ?? type.getSymbol())?.getDeclarations() ?? [],
    moduleName,
    projectModulesRoot,
  );
}

function symbolKey(symbol: ts.Symbol | undefined, fallback: string): string {
  const declaration = symbol?.getDeclarations()?.[0];
  return declaration === undefined
    ? fallback
    : `${declaration.getSourceFile().fileName}:${declaration.pos}`;
}

function expressionName(expression: ts.Expression): string {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    return current.name.text;
  }
  if (ts.isIdentifier(current)) {
    return current.text;
  }
  return current.getText(current.getSourceFile());
}

function projectDependency(
  expression: ts.Expression,
  moduleName: string,
  projectModulesRoot: string,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): ProjectDependency | undefined {
  const current = unwrapExpression(expression);
  const symbol = expressionSymbol(current, checker);
  if (symbol !== undefined && !seen.has(symbol)) {
    seen.add(symbol);
    for (const declaration of symbol.getDeclarations() ?? []) {
      if (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined
      ) {
        const dependency = projectDependency(
          declaration.initializer,
          moduleName,
          projectModulesRoot,
          checker,
          seen,
        );
        if (dependency !== undefined) {
          return dependency;
        }
      }
      if (ts.isBindingElement(declaration)) {
        const dependency = bindingDependency(
          declaration,
          moduleName,
          projectModulesRoot,
          checker,
          seen,
        );
        if (dependency !== undefined) {
          return dependency;
        }
      }
    }
  }
  const origin = typeOrigin(
    checker.getTypeAtLocation(current),
    moduleName,
    projectModulesRoot,
  );
  return origin === 'external'
    ? undefined
    : {
        key: symbolKey(symbol, current.getText(current.getSourceFile())),
        name: expressionName(current),
        origin,
      };
}

function bindingInitializer(
  binding: ts.BindingElement,
): ts.Expression | undefined {
  let current: ts.Node | undefined = binding.parent;
  while (current !== undefined && !ts.isVariableDeclaration(current)) {
    current = current.parent;
  }
  return current?.initializer;
}

function bindingDependency(
  binding: ts.BindingElement,
  moduleName: string,
  projectModulesRoot: string,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): ProjectDependency | undefined {
  const initializer = bindingInitializer(binding);
  if (initializer === undefined) {
    return undefined;
  }
  const sourceDependency = projectDependency(
    initializer,
    moduleName,
    projectModulesRoot,
    checker,
    seen,
  );
  if (sourceDependency?.origin === 'application') {
    return sourceDependency;
  }
  if (!ts.isObjectBindingPattern(binding.parent)) {
    return sourceDependency;
  }
  const propertyName = (binding.propertyName ?? binding.name).getText(
    binding.getSourceFile(),
  );
  const property = checker
    .getTypeAtLocation(initializer)
    .getProperty(propertyName);
  const origin =
    property === undefined
      ? 'external'
      : typeOrigin(
          checker.getTypeOfSymbolAtLocation(property, initializer),
          moduleName,
          projectModulesRoot,
        );
  return origin === 'external'
    ? sourceDependency
    : {
        key: symbolKey(property, propertyName),
        name: propertyName,
        origin,
      };
}

function callableDependency(
  expression: ts.Expression,
  moduleName: string,
  projectModulesRoot: string,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): ProjectDependency | undefined {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    if (
      (current.name.text === 'bind' ||
        current.name.text === 'call' ||
        current.name.text === 'apply') &&
      ts.isPropertyAccessExpression(current.expression)
    ) {
      return callableDependency(
        current.expression,
        moduleName,
        projectModulesRoot,
        checker,
        seen,
      );
    }
    return projectDependency(
      current.expression,
      moduleName,
      projectModulesRoot,
      checker,
      seen,
    );
  }
  const symbol = expressionSymbol(current, checker);
  if (symbol !== undefined && !seen.has(symbol)) {
    for (const declaration of symbol.getDeclarations() ?? []) {
      if (
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined
      ) {
        seen.add(symbol);
        const dependency = callableDependency(
          declaration.initializer,
          moduleName,
          projectModulesRoot,
          checker,
          seen,
        );
        if (dependency !== undefined) {
          return dependency;
        }
      }
      if (ts.isBindingElement(declaration)) {
        seen.add(symbol);
        const dependency = bindingDependency(
          declaration,
          moduleName,
          projectModulesRoot,
          checker,
          seen,
        );
        if (dependency !== undefined) {
          return dependency;
        }
      }
    }
  }
  return projectDependency(
    current,
    moduleName,
    projectModulesRoot,
    checker,
    seen,
  );
}

function methodName(
  method: ts.MethodDeclaration,
  sourceFile: ts.SourceFile,
): string {
  return method.name.getText(sourceFile);
}

export function collectControllerHandlerViolations(
  sourceFile: ts.SourceFile,
  relativeSourcePath: string,
  moduleName: string,
  projectModulesRoot: string,
  checker: ts.TypeChecker,
): string[] {
  const violations: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement)) {
      continue;
    }
    const className = statement.name?.text ?? '<anonymous>';
    for (const member of statement.members) {
      if (
        !ts.isMethodDeclaration(member) ||
        member.body === undefined ||
        !isNestRouteMethod(member, checker)
      ) {
        continue;
      }
      const applicationDependencies = new Map<string, string>();
      const nonApplicationDependencies = new Map<string, string>();
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const dependency = callableDependency(
            reflectedCallableTarget(node, checker) ?? node.expression,
            moduleName,
            projectModulesRoot,
            checker,
            new Set(),
          );
          if (dependency !== undefined) {
            if (dependency.origin === 'application') {
              applicationDependencies.set(dependency.key, dependency.name);
            } else {
              nonApplicationDependencies.set(dependency.key, dependency.name);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(member.body);
      if (
        applicationDependencies.size === 1 &&
        nonApplicationDependencies.size === 0
      ) {
        continue;
      }
      const wrongDependencies =
        nonApplicationDependencies.size === 0
          ? ''
          : `; non-application dependencies: ${[
              ...nonApplicationDependencies.values(),
            ]
              .sort()
              .join(', ')}`;
      violations.push(
        `${relativeSourcePath} route handler ${className}.${methodName(member, sourceFile)} must delegate to exactly one application use case; found ${applicationDependencies.size}${wrongDependencies}`,
      );
    }
  }
  return violations;
}
