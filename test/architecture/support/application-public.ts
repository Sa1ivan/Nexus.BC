import path from 'node:path';
import ts from 'typescript';
import type { OriginResolver } from '../types/architecture.types';
import { canonicalPath, classifyModuleLocation } from './module-paths';

function hasExportModifier(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function hasModifier(node: ts.Node, kind: ts.ModifierSyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
  );
}

function isGlobalSymbolReference(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): boolean {
  const symbolExpression = ts.isIdentifier(expression)
    ? expression
    : ts.isPropertyAccessExpression(expression) &&
        expression.name.text === 'for' &&
        ts.isIdentifier(expression.expression)
      ? expression.expression
      : undefined;
  if (symbolExpression?.text !== 'Symbol') {
    return false;
  }
  const symbol = checker.getSymbolAtLocation(symbolExpression);
  return !symbol
    ?.getDeclarations()
    ?.some((declaration) => declaration.getSourceFile() === sourceFile);
}

function isSymbolTokenDeclaration(
  declaration: ts.Declaration,
  resolver: OriginResolver,
): boolean {
  return (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    ts.isCallExpression(declaration.initializer) &&
    isGlobalSymbolReference(
      declaration.initializer.expression,
      declaration.getSourceFile(),
      resolver.checker,
    )
  );
}

function isApplicationContractDeclaration(
  declaration: ts.Declaration,
  moduleName: string,
  projectModulesRoot: string,
  resolver: OriginResolver,
  seenSymbols = new Set<ts.Symbol>(),
): boolean {
  const location = classifyModuleLocation(
    declaration.getSourceFile().fileName,
    projectModulesRoot,
  );
  const isContractKind =
    ts.isInterfaceDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration);
  return (
    location?.moduleName === moduleName &&
    location.layer === 'application' &&
    (isSymbolTokenDeclaration(declaration, resolver) ||
      (isContractKind &&
        hasOnlyApplicationTypeReferences(
          declaration,
          moduleName,
          projectModulesRoot,
          resolver,
          seenSymbols,
        )))
  );
}

function isNodeWithin(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (current === ancestor) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isWithinProjectSource(
  fileName: string,
  resolver: OriginResolver,
): boolean {
  const relativePath = path.relative(
    canonicalPath(resolver.sourceRoot),
    canonicalPath(fileName),
  );
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function isOpaqueTransactionContextReference(
  symbol: ts.Symbol,
  resolver: OriginResolver,
): boolean {
  if (symbol.getName() !== 'TransactionContext') {
    return false;
  }
  const declarations = symbol.getDeclarations() ?? [];
  const expectedSource = canonicalPath(
    path.join(
      resolver.sourceRoot,
      'shared',
      'database',
      'transaction-runner.ts',
    ),
  );

  const isOpaqueBrandDeclaration = (declaration: ts.Declaration): boolean => {
    if (
      !ts.isVariableDeclaration(declaration) ||
      !ts.isIdentifier(declaration.name) ||
      declaration.name.text !== 'transactionContextBrand' ||
      declaration.initializer !== undefined ||
      declaration.type === undefined ||
      !ts.isTypeOperatorNode(declaration.type) ||
      declaration.type.operator !== ts.SyntaxKind.UniqueKeyword ||
      declaration.type.type.kind !== ts.SyntaxKind.SymbolKeyword ||
      canonicalPath(declaration.getSourceFile().fileName) !== expectedSource
    ) {
      return false;
    }

    const declarationList = declaration.parent;
    const statement = declarationList.parent;
    return (
      ts.isVariableDeclarationList(declarationList) &&
      (declarationList.flags & ts.NodeFlags.Const) !== 0 &&
      ts.isVariableStatement(statement) &&
      hasModifier(statement, ts.SyntaxKind.DeclareKeyword) &&
      !hasExportModifier(statement)
    );
  };

  const hasOpaqueBrandMember = (member: ts.TypeElement): boolean => {
    if (
      !ts.isPropertySignature(member) ||
      !hasModifier(member, ts.SyntaxKind.ReadonlyKeyword) ||
      member.questionToken !== undefined ||
      member.initializer !== undefined ||
      !ts.isComputedPropertyName(member.name) ||
      !ts.isIdentifier(member.name.expression) ||
      member.type === undefined ||
      !ts.isLiteralTypeNode(member.type) ||
      member.type.literal.kind !== ts.SyntaxKind.TrueKeyword
    ) {
      return false;
    }

    const brandSymbol = resolver.checker.getSymbolAtLocation(
      member.name.expression,
    );
    return (
      brandSymbol !== undefined &&
      (brandSymbol.getDeclarations() ?? []).length === 1 &&
      (brandSymbol.getDeclarations() ?? []).every(isOpaqueBrandDeclaration)
    );
  };

  return (
    declarations.length === 1 &&
    declarations.every(
      (declaration) =>
        ts.isInterfaceDeclaration(declaration) &&
        declaration.name.text === 'TransactionContext' &&
        canonicalPath(declaration.getSourceFile().fileName) ===
          expectedSource &&
        hasExportModifier(declaration) &&
        declaration.typeParameters === undefined &&
        declaration.heritageClauses === undefined &&
        declaration.members.length === 1 &&
        declaration.members.every(hasOpaqueBrandMember),
    )
  );
}

function isAllowedTypeReference(
  symbol: ts.Symbol,
  rootDeclaration: ts.Declaration,
  moduleName: string,
  projectModulesRoot: string,
  resolver: OriginResolver,
  seenSymbols: Set<ts.Symbol>,
): boolean {
  const target =
    (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? resolver.checker.getAliasedSymbol(symbol)
      : symbol;
  if (isOpaqueTransactionContextReference(target, resolver)) {
    return true;
  }
  if (seenSymbols.has(target)) {
    return true;
  }
  const declarations = target.getDeclarations() ?? [];
  if (declarations.length === 0) {
    return true;
  }
  seenSymbols.add(target);
  const allowed = declarations.every((declaration) => {
    if (
      isNodeWithin(declaration, rootDeclaration) ||
      ts.isTypeParameterDeclaration(declaration) ||
      !isWithinProjectSource(declaration.getSourceFile().fileName, resolver)
    ) {
      return true;
    }
    return isApplicationContractDeclaration(
      declaration,
      moduleName,
      projectModulesRoot,
      resolver,
      seenSymbols,
    );
  });
  seenSymbols.delete(target);
  return allowed;
}

function hasOnlyApplicationTypeReferences(
  declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
  moduleName: string,
  projectModulesRoot: string,
  resolver: OriginResolver,
  seenSymbols: Set<ts.Symbol>,
): boolean {
  let allowed = true;
  const visit = (node: ts.Node): void => {
    if (!allowed) {
      return;
    }
    if (ts.isIdentifier(node)) {
      const symbol = resolver.checker.getSymbolAtLocation(node);
      if (
        symbol !== undefined &&
        !isAllowedTypeReference(
          symbol,
          declaration,
          moduleName,
          projectModulesRoot,
          resolver,
          seenSymbols,
        )
      ) {
        allowed = false;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  if (ts.isTypeAliasDeclaration(declaration)) {
    visit(declaration.type);
  } else {
    for (const heritageClause of declaration.heritageClauses ?? []) {
      visit(heritageClause);
    }
    for (const member of declaration.members) {
      visit(member);
    }
  }
  return allowed;
}

function exportSymbolDeclarations(
  node: ts.Node,
  resolver: OriginResolver,
): readonly ts.Declaration[] {
  const symbol = resolver.checker.getSymbolAtLocation(node);
  if (symbol === undefined) {
    return [];
  }
  const target =
    (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? resolver.checker.getAliasedSymbol(symbol)
      : symbol;
  return target.getDeclarations() ?? [];
}

function addNamedExportViolations(
  declaration: ts.ExportDeclaration,
  relativeSourcePath: string,
  moduleName: string,
  projectModulesRoot: string,
  resolver: OriginResolver,
  violations: string[],
): void {
  if (
    declaration.exportClause === undefined ||
    ts.isNamespaceExport(declaration.exportClause)
  ) {
    violations.push(publicSurfaceViolation(relativeSourcePath, '*'));
    return;
  }

  for (const element of declaration.exportClause.elements) {
    const declarations = exportSymbolDeclarations(
      element.propertyName ?? element.name,
      resolver,
    );
    if (
      declarations.length === 0 ||
      declarations.some(
        (symbolDeclaration) =>
          !isApplicationContractDeclaration(
            symbolDeclaration,
            moduleName,
            projectModulesRoot,
            resolver,
          ),
      )
    ) {
      violations.push(
        publicSurfaceViolation(relativeSourcePath, element.name.text),
      );
    }
  }
}

function publicSurfaceViolation(
  relativeSourcePath: string,
  exportName: string,
): string {
  return `${relativeSourcePath} application/public.ts may not export ${exportName}; only same-module application type/interface contracts and Symbol DI tokens are public`;
}

export function collectApplicationPublicViolations(
  sourceFile: ts.SourceFile,
  relativeSourcePath: string,
  moduleName: string,
  projectModulesRoot: string,
  resolver: OriginResolver,
): string[] {
  const violations: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      addNamedExportViolations(
        statement,
        relativeSourcePath,
        moduleName,
        projectModulesRoot,
        resolver,
        violations,
      );
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      violations.push(publicSurfaceViolation(relativeSourcePath, 'default'));
      continue;
    }
    if (!hasExportModifier(statement)) {
      continue;
    }
    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)
    ) {
      if (
        !isApplicationContractDeclaration(
          statement,
          moduleName,
          projectModulesRoot,
          resolver,
        )
      ) {
        violations.push(
          publicSurfaceViolation(
            relativeSourcePath,
            statement.name.getText(sourceFile),
          ),
        );
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!isSymbolTokenDeclaration(declaration, resolver)) {
          const names: string[] = [];
          const collectNames = (name: ts.BindingName): void => {
            if (ts.isIdentifier(name)) {
              names.push(name.text);
              return;
            }
            for (const element of name.elements) {
              if (!ts.isOmittedExpression(element)) {
                collectNames(element.name);
              }
            }
          };
          collectNames(declaration.name);
          for (const name of names) {
            violations.push(publicSurfaceViolation(relativeSourcePath, name));
          }
        }
      }
      continue;
    }
    const declarationName =
      (ts.isClassDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
        ? statement.name?.getText(sourceFile)
        : undefined) ?? 'default';
    violations.push(
      publicSurfaceViolation(relativeSourcePath, declarationName),
    );
  }
  return violations;
}
