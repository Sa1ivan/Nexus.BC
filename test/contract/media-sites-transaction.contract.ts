import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import {
  createArchitectureFixture,
  removeArchitectureFixture,
} from '../architecture/support/architecture-fixture';
import { findArchitectureViolations } from '../architecture/support/architecture-scanner';

const sourceRoot = join(process.cwd(), 'src');
const mediaApplicationRoot = join(sourceRoot, 'modules/media/application');
const sitesApplicationRoot = join(sourceRoot, 'modules/sites/application');
const mediaModuleRoot = join(sourceRoot, 'modules/media');
const sitesModuleRoot = join(sourceRoot, 'modules/sites');

interface PublicTransactionSurface {
  readonly symbols: number;
  readonly transactionMethods: number;
}

interface RegisteredPortBinding {
  readonly implementationAlternatives: readonly (readonly ts.SignatureDeclaration[])[];
  readonly token: ts.Symbol;
}

function typescriptFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.spec.ts'),
    )
    .map((entry) => join(entry.parentPath, entry.name));
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

function publicContractMembers(
  statement: ts.Statement,
): ts.NodeArray<ts.TypeElement> | undefined {
  if (ts.isInterfaceDeclaration(statement)) return statement.members;
  if (
    ts.isTypeAliasDeclaration(statement) &&
    ts.isTypeLiteralNode(statement.type)
  ) {
    return statement.type.members;
  }
  return undefined;
}

function publicTransactionSurface(file: string): PublicTransactionSurface {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let symbols = 0;
  let transactionMethods = 0;
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      symbols += statement.declarationList.declarations.filter(
        (declaration) =>
          declaration.initializer !== undefined &&
          ts.isCallExpression(declaration.initializer) &&
          declaration.initializer.expression.getText(source) === 'Symbol',
      ).length;
    }
    const members = publicContractMembers(statement);
    if (members === undefined || !hasExportModifier(statement)) continue;
    transactionMethods += members.filter((member) => {
      const parameters = ts.isMethodSignature(member)
        ? member.parameters
        : ts.isPropertySignature(member) &&
            member.type !== undefined &&
            ts.isFunctionTypeNode(member.type)
          ? member.type.parameters
          : undefined;
      const firstParameter = parameters?.[0];
      return (
        firstParameter?.type !== undefined &&
        firstParameter.type.getText(source) === 'TransactionContext'
      );
    }).length;
  }
  return { symbols, transactionMethods };
}

function createSourceProgram(): ts.Program {
  const configPath = ts.findConfigFile(process.cwd(), (file) =>
    ts.sys.fileExists(file),
  );
  if (configPath === undefined) throw new Error('tsconfig.json not found');
  const config = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  if (config.error !== undefined) {
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    process.cwd(),
  );
  return ts.createProgram(parsed.fileNames, parsed.options);
}

function createAnalyzerFixture(
  sourceText: string,
  fileName = '/contract-analyzer-fixture.ts',
): {
  readonly program: ts.Program;
  readonly source: ts.SourceFile;
} {
  const file = resolve(fileName);
  const options: ts.CompilerOptions = {
    experimentalDecorators: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const source = ts.createSourceFile(
    file,
    sourceText,
    options.target ?? ts.ScriptTarget.ES2022,
    true,
  );
  host.fileExists = (candidate) =>
    resolve(candidate) === file || ts.sys.fileExists(candidate);
  host.readFile = (candidate) =>
    resolve(candidate) === file ? sourceText : ts.sys.readFile(candidate);
  host.getSourceFile = (candidate, languageVersion, ...rest) =>
    resolve(candidate) === file
      ? source
      : originalGetSourceFile(candidate, languageVersion, ...rest);
  return { program: ts.createProgram([file], options, host), source };
}

function resolvedSymbol(
  checker: ts.TypeChecker,
  node: ts.Node,
): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) return undefined;
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function declaredIn(symbol: ts.Symbol | undefined, file: string): boolean {
  return (
    symbol?.declarations?.some(
      (declaration) => resolve(declaration.getSourceFile().fileName) === file,
    ) ?? false
  );
}

function executableCalls(
  checker: ts.TypeChecker,
  root: ts.Node,
): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const isInvokedCallback = (
    node: ts.ArrowFunction | ts.FunctionExpression,
  ): boolean => {
    let current: ts.Node = node;
    let property: ts.PropertyAssignment | undefined;
    while (
      ts.isPropertyAssignment(current.parent) ||
      ts.isObjectLiteralExpression(current.parent) ||
      ts.isParenthesizedExpression(current.parent)
    ) {
      current = current.parent;
      if (ts.isPropertyAssignment(current)) property = current;
    }
    if (!ts.isCallExpression(current.parent)) return false;
    const outerCall = current.parent;
    const declaration = checker.getResolvedSignature(outerCall)?.declaration;
    if (declaration === undefined) return false;
    const argumentIndex = outerCall.arguments.findIndex(
      (argument) => argument === current,
    );
    const parameter = declaration.parameters[argumentIndex];
    if (parameter === undefined) return false;
    const parameterSymbol = resolvedSymbol(checker, parameter.name);
    if (parameterSymbol === undefined) return false;
    const propertyName = property?.name.getText(property.getSourceFile());
    const queue = [{ declaration, value: parameterSymbol }];
    const visited = new Map<ts.SignatureDeclaration, Set<ts.Symbol>>();
    while (queue.length > 0 && visited.size < 40) {
      const state = queue.shift();
      if (state === undefined) continue;
      const values = visited.get(state.declaration) ?? new Set<ts.Symbol>();
      if (values.has(state.value)) continue;
      values.add(state.value);
      visited.set(state.declaration, values);
      let invoked = false;
      const visit = (candidate: ts.Node): void => {
        if (invoked) return;
        if (ts.isCallExpression(candidate)) {
          if (
            propertyName === undefined &&
            usesSymbol(checker, candidate.expression, state.value)
          ) {
            invoked = true;
            return;
          }
          if (
            propertyName !== undefined &&
            ts.isPropertyAccessExpression(candidate.expression) &&
            candidate.expression.name.getText() === propertyName &&
            usesSymbol(checker, candidate.expression.expression, state.value)
          ) {
            invoked = true;
            return;
          }
          const nested = checker.getResolvedSignature(candidate)?.declaration;
          if (nested !== undefined) {
            candidate.arguments.forEach((argument, index) => {
              if (!usesSymbol(checker, argument, state.value)) return;
              const nestedParameter = nested.parameters[index];
              const value =
                nestedParameter === undefined
                  ? undefined
                  : resolvedSymbol(checker, nestedParameter.name);
              if (value !== undefined) {
                queue.push({ declaration: nested, value });
              }
            });
          }
        }
        ts.forEachChild(candidate, visit);
      };
      visit(state.declaration);
      if (invoked) return true;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (
      node !== root &&
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
          !isInvokedCallback(node)))
    ) {
      return;
    }
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return calls;
}

function registeredOperationEntries(
  program: ts.Program,
  file: string,
): ts.MethodDeclaration[][] {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  if (source === undefined) return [];
  const providerExpressions = new Map<ts.Symbol, ts.Expression>();
  for (const candidate of program.getSourceFiles()) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(candidate) === 'providers' &&
        ts.isArrayLiteralExpression(node.initializer)
      ) {
        for (const provider of node.initializer.elements) {
          if (ts.isIdentifier(provider)) {
            const symbol = resolvedSymbol(checker, provider);
            if (symbol !== undefined) providerExpressions.set(symbol, provider);
          } else if (ts.isObjectLiteralExpression(provider)) {
            const provide = provider.properties.find(
              (property): property is ts.PropertyAssignment =>
                ts.isPropertyAssignment(property) &&
                property.name.getText(candidate) === 'provide',
            );
            const implementation = provider.properties.find(
              (property): property is ts.PropertyAssignment =>
                ts.isPropertyAssignment(property) &&
                ['useClass', 'useExisting', 'useFactory'].includes(
                  property.name.getText(candidate),
                ),
            );
            const token =
              provide === undefined
                ? undefined
                : resolvedSymbol(checker, provide.initializer);
            if (token !== undefined && implementation !== undefined) {
              providerExpressions.set(token, implementation.initializer);
            }
            // A direct useClass remains a registered operation even when its
            // provider token is an alias rather than the class itself.
            for (const property of provider.properties) {
              if (
                ts.isPropertyAssignment(property) &&
                property.name.getText(candidate) === 'useClass' &&
                ts.isIdentifier(property.initializer)
              ) {
                const symbol = resolvedSymbol(checker, property.initializer);
                if (symbol !== undefined) {
                  providerExpressions.set(symbol, property.initializer);
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(candidate);
  }
  const registered = new Set<ts.Symbol>();
  const resolveProvider = (
    expression: ts.Expression,
    seen: Set<ts.Symbol>,
  ): void => {
    const symbol = resolvedSymbol(checker, expression);
    if (symbol !== undefined) {
      if (seen.has(symbol)) return;
      seen.add(symbol);
      if (
        symbol.declarations?.some((declaration) =>
          ts.isClassDeclaration(declaration),
        )
      ) {
        registered.add(symbol);
      }
      const alias = providerExpressions.get(symbol);
      if (alias !== undefined && alias !== expression) {
        resolveProvider(alias, seen);
      }
    }
    for (const constructed of actualFactoryClassSymbols(checker, expression)) {
      registered.add(constructed);
    }
  };
  for (const expression of providerExpressions.values()) {
    resolveProvider(expression, new Set());
  }
  const alternatives: ts.MethodDeclaration[][] = [];
  const seen = new Set<ts.MethodDeclaration>();
  const methodFor = (
    classSymbol: ts.Symbol,
    memberName: string,
  ): ts.MethodDeclaration | undefined =>
    (classSymbol.declarations ?? [])
      .filter(ts.isClassDeclaration)
      .flatMap((declaration) => [...declaration.members])
      .find(
        (member): member is ts.MethodDeclaration =>
          ts.isMethodDeclaration(member) &&
          member.body !== undefined &&
          member.name.getText(member.getSourceFile()) === memberName &&
          resolve(member.getSourceFile().fileName) === resolve(file),
      );
  const resolveProviderClasses = (
    expression: ts.Expression,
    visited: Set<ts.Symbol>,
  ): ts.Symbol[] => {
    const symbol = resolvedSymbol(checker, expression);
    if (symbol !== undefined) {
      if (visited.has(symbol)) return [];
      visited.add(symbol);
      const mappedProvider = providerExpressions.get(symbol);
      const mappedSymbol =
        mappedProvider === undefined
          ? undefined
          : resolvedSymbol(checker, mappedProvider);
      if (mappedProvider !== undefined && mappedSymbol !== symbol) {
        return resolveProviderClasses(mappedProvider, visited);
      }
      if (
        symbol.declarations?.some((declaration) =>
          ts.isClassDeclaration(declaration),
        )
      ) {
        return [symbol];
      }
    }
    return actualFactoryClassSymbols(checker, expression);
  };
  for (const candidate of program.getSourceFiles()) {
    if (!candidate.fileName.includes('/api/')) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const injectedProviders = receiverInjectedTokens(checker, node).filter(
          (token) => providerExpressions.has(token),
        );
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if (
          injectedProviders.length === 0 &&
          declaration !== undefined &&
          ts.isMethodDeclaration(declaration) &&
          resolve(declaration.getSourceFile().fileName) === resolve(file)
        ) {
          const parent = declaration.parent;
          const classSymbol =
            ts.isClassDeclaration(parent) && parent.name !== undefined
              ? resolvedSymbol(checker, parent.name)
              : undefined;
          if (
            classSymbol !== undefined &&
            registered.has(classSymbol) &&
            !seen.has(declaration)
          ) {
            seen.add(declaration);
            alternatives.push([declaration]);
          }
        }
        if (ts.isPropertyAccessExpression(node.expression)) {
          const memberName = node.expression.name.text;
          for (const token of injectedProviders) {
            const provider = providerExpressions.get(token);
            if (provider === undefined) continue;
            const classes = resolveProviderClasses(provider, new Set([token]));
            if (classes.length === 0) continue;
            const methods = classes.map((classSymbol) =>
              methodFor(classSymbol, memberName),
            );
            if (
              methods.every(
                (method): method is ts.MethodDeclaration =>
                  method !== undefined,
              )
            ) {
              alternatives.push(methods);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(candidate);
  }
  return alternatives;
}

function operationExecutionTrace(
  program: ts.Program,
  entry: ts.MethodDeclaration,
): ts.CallExpression[] {
  const checker = program.getTypeChecker();
  const trace: ts.CallExpression[] = [];
  const active = new Set<ts.Node>();
  const append = (declaration: ts.Node): void => {
    if (active.has(declaration) || active.size >= 80) return;
    active.add(declaration);
    for (const call of executableCalls(checker, declaration).sort(
      (left, right) => left.getStart() - right.getStart(),
    )) {
      trace.push(call);
      const resolved = checker.getResolvedSignature(call)?.declaration;
      if (
        resolved !== undefined &&
        resolved.getSourceFile().fileName.startsWith(sourceRoot) &&
        ((ts.isMethodDeclaration(resolved) && resolved.body !== undefined) ||
          (ts.isFunctionDeclaration(resolved) && resolved.body !== undefined) ||
          ts.isArrowFunction(resolved) ||
          ts.isFunctionExpression(resolved))
      ) {
        append(resolved);
      }
    }
    active.delete(declaration);
  };
  append(entry);
  return trace;
}

function contractTypeAndMember(
  checker: ts.TypeChecker,
  declaration: ts.SignatureDeclaration,
): { readonly type: ts.Type; readonly memberName: string } | undefined {
  if (ts.isMethodSignature(declaration)) {
    return {
      type: checker.getTypeAtLocation(declaration.parent),
      memberName: declaration.name.getText(declaration.getSourceFile()),
    };
  }
  if (
    ts.isFunctionTypeNode(declaration) &&
    ts.isPropertySignature(declaration.parent)
  ) {
    return {
      type: checker.getTypeAtLocation(declaration.parent.parent),
      memberName: declaration.parent.name.getText(declaration.getSourceFile()),
    };
  }
  return undefined;
}

function memberImplementations(
  checker: ts.TypeChecker,
  declaration: ts.Declaration,
  contract: { readonly type: ts.Type; readonly memberName: string },
): ts.SignatureDeclaration[] {
  if (!ts.isClassDeclaration(declaration) || declaration.name === undefined) {
    return [];
  }
  const classType = checker.getTypeAtLocation(declaration.name);
  if (!checker.isTypeAssignableTo(classType, contract.type)) return [];
  return (
    classType.getProperty(contract.memberName)?.declarations ?? []
  ).flatMap((member): ts.SignatureDeclaration[] => {
    if (ts.isMethodDeclaration(member)) return [member];
    if (
      ts.isPropertyDeclaration(member) &&
      member.initializer !== undefined &&
      (ts.isArrowFunction(member.initializer) ||
        ts.isFunctionExpression(member.initializer))
    ) {
      return [member.initializer];
    }
    return [];
  });
}

function factoryReturnedExpressions(
  declaration: ts.SignatureDeclaration,
): ts.Expression[] {
  if (ts.isArrowFunction(declaration) && !ts.isBlock(declaration.body)) {
    return [declaration.body];
  }
  const body =
    'body' in declaration && declaration.body !== undefined
      ? declaration.body
      : undefined;
  if (body === undefined) return [];
  const returned: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      node !== body &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isClassDeclaration(node))
    ) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      returned.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return returned;
}

function returnedClassSymbols(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen: Set<ts.Symbol> = new Set(),
): ts.Symbol[] {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return returnedClassSymbols(checker, expression.expression, seen);
  }
  if (ts.isConditionalExpression(expression)) {
    const whenTrue = returnedClassSymbols(checker, expression.whenTrue, seen);
    const whenFalse = returnedClassSymbols(checker, expression.whenFalse, seen);
    return whenTrue.length > 0 && whenFalse.length > 0
      ? [...whenTrue, ...whenFalse]
      : [];
  }
  if (ts.isNewExpression(expression)) {
    const constructed = resolvedSymbol(checker, expression.expression);
    return constructed === undefined ? [] : [constructed];
  }
  if (ts.isIdentifier(expression)) {
    const symbol = resolvedSymbol(checker, expression);
    if (symbol === undefined || seen.has(symbol)) return [];
    seen.add(symbol);
    const initializers = (symbol.declarations ?? []).flatMap((declaration) =>
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined
        ? [declaration.initializer]
        : [],
    );
    if (initializers.length !== 1) return [];
    return returnedClassSymbols(
      checker,
      initializers[0] as ts.Expression,
      seen,
    );
  }
  return [];
}

function actualFactoryClassSymbols(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): ts.Symbol[] {
  const factory = checker
    .getTypeAtLocation(expression)
    .getCallSignatures()[0]?.declaration;
  if (factory === undefined) return [];
  const returned = factoryReturnedExpressions(factory);
  if (returned.length === 0) return [];
  const alternatives: ts.Symbol[] = [];
  for (const returnedExpression of returned) {
    const classes = returnedClassSymbols(checker, returnedExpression);
    if (classes.length === 0) return [];
    alternatives.push(...classes);
  }
  return alternatives;
}

function registeredPortBinding(
  program: ts.Program,
  moduleRoot: string,
  publicTokens: ReadonlySet<ts.Symbol>,
  declaration: ts.SignatureDeclaration,
): RegisteredPortBinding | undefined {
  const checker = program.getTypeChecker();
  const contract = contractTypeAndMember(checker, declaration);
  if (contract === undefined) return undefined;
  const providers = new Map<ts.Symbol, ts.Expression>();
  const directClasses = new Map<ts.Symbol, ts.ClassDeclaration>();
  for (const source of program.getSourceFiles()) {
    if (!source.fileName.startsWith(moduleRoot)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name !== undefined) {
        const symbol = resolvedSymbol(checker, node.name);
        if (symbol !== undefined) directClasses.set(symbol, node);
      }
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(source) === 'providers' &&
        ts.isArrayLiteralExpression(node.initializer)
      ) {
        for (const provider of node.initializer.elements) {
          if (ts.isIdentifier(provider)) {
            const symbol = resolvedSymbol(checker, provider);
            if (symbol !== undefined) providers.set(symbol, provider);
            continue;
          }
          if (!ts.isObjectLiteralExpression(provider)) continue;
          const provide = provider.properties.find(
            (property): property is ts.PropertyAssignment =>
              ts.isPropertyAssignment(property) &&
              property.name.getText(source) === 'provide',
          );
          const implementation = provider.properties.find(
            (property): property is ts.PropertyAssignment =>
              ts.isPropertyAssignment(property) &&
              ['useClass', 'useExisting', 'useFactory'].includes(
                property.name.getText(source),
              ),
          );
          if (provide === undefined || implementation === undefined) continue;
          const token = resolvedSymbol(checker, provide.initializer);
          if (token !== undefined)
            providers.set(token, implementation.initializer);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const resolveImplementation = (
    expression: ts.Expression,
    seen: Set<ts.Symbol>,
  ): ts.SignatureDeclaration[][] => {
    const symbol = resolvedSymbol(checker, expression);
    if (symbol !== undefined) {
      if (seen.has(symbol)) return [];
      seen.add(symbol);
      const provider = providers.get(symbol);
      if (provider !== undefined && provider !== expression) {
        const resolved = resolveImplementation(provider, seen);
        if (resolved.length > 0) return resolved;
      }
      const direct = directClasses.get(symbol);
      if (direct !== undefined) {
        const members = memberImplementations(checker, direct, contract);
        return members.length === 0 ? [] : [members];
      }
      for (const symbolDeclaration of symbol.declarations ?? []) {
        const implementations = memberImplementations(
          checker,
          symbolDeclaration,
          contract,
        );
        if (implementations.length > 0) return [implementations];
      }
    }
    // Every actual return branch must resolve to a class that implements the
    // required member. Arbitrary object factories intentionally remain outside
    // this static proof.
    const callable = checker
      .getTypeAtLocation(expression)
      .getCallSignatures()[0];
    if (callable === undefined) return [];
    const returnType = checker.getReturnTypeOfSignature(callable);
    if (!checker.isTypeAssignableTo(returnType, contract.type)) return [];
    const factoryDeclaration = callable.declaration;
    if (factoryDeclaration === undefined) return [];
    const classes = actualFactoryClassSymbols(checker, expression);
    if (classes.length === 0) return [];
    const alternatives: ts.SignatureDeclaration[][] = [];
    for (const constructed of classes) {
      const members = (constructed.declarations ?? []).flatMap(
        (classDeclaration) =>
          memberImplementations(checker, classDeclaration, contract),
      );
      if (members.length === 0) return [];
      alternatives.push(members);
    }
    return alternatives;
  };
  for (const token of publicTokens) {
    const provider = providers.get(token);
    if (provider === undefined) continue;
    const implementationAlternatives = resolveImplementation(
      provider,
      new Set([token]),
    );
    if (implementationAlternatives.length > 0) {
      return { implementationAlternatives, token };
    }
  }
  return undefined;
}

function queryText(node: ts.Node): string | undefined {
  if (ts.isTaggedTemplateExpression(node)) return node.template.getText();
  if (!ts.isCallExpression(node)) return undefined;
  const literal = node.arguments.find(
    (argument) =>
      ts.isStringLiteral(argument) ||
      ts.isNoSubstitutionTemplateLiteral(argument) ||
      ts.isTemplateExpression(argument),
  );
  return literal?.getText();
}

function hasDatabaseSortedMediaLock(node: ts.Node): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    const sql = queryText(candidate);
    const order =
      sql === undefined
        ? undefined
        : /ORDER\s+BY\s+([^;,]+)(?:,[^;]+)?\s+FOR\s+(?:NO\s+KEY\s+)?UPDATE/iu.exec(
            sql,
          );
    const leading = order?.[1]?.trim();
    if (
      sql !== undefined &&
      /MediaAsset/iu.test(sql) &&
      leading !== undefined &&
      /^(?:(?:"[^"]+"|[A-Z_]\w*)\.)?(?:"id"|id)(?:\s+ASC)?$/iu.test(leading)
    ) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

function queryTemplate(node: ts.Node): ts.TemplateLiteral | undefined {
  if (ts.isTaggedTemplateExpression(node)) return node.template;
  if (!ts.isCallExpression(node)) return undefined;
  return node.arguments.find(
    (argument): argument is ts.TemplateLiteral =>
      ts.isNoSubstitutionTemplateLiteral(argument) ||
      ts.isTemplateExpression(argument),
  );
}

function mediaSetLockPredicateUsesValue(
  checker: ts.TypeChecker,
  node: ts.Node,
  value: ts.Symbol,
): boolean {
  const sql = queryText(node);
  if (
    sql === undefined ||
    !hasDatabaseSortedMediaLock(node) ||
    !/WHERE[\s\S]*(?:(?:"[^"]+"|[A-Z_]\w*)\.)?(?:"id"|\bid\b)\s*(?:IN\s*\(|=\s*ANY\s*\()/iu.test(
      sql,
    )
  ) {
    return false;
  }
  const template = queryTemplate(node);
  if (template !== undefined && ts.isTemplateExpression(template)) {
    let before = template.head.text;
    for (const span of template.templateSpans) {
      if (
        usesSymbol(checker, span.expression, value) &&
        /WHERE[\s\S]*(?:(?:"[^"]+"|[A-Z_]\w*)\.)?(?:"id"|\bid\b)\s*(?:IN\s*\(|=\s*ANY\s*\()\s*$/iu.test(
          before,
        )
      ) {
        return true;
      }
      before += `\${value}${span.literal.text}`;
    }
  }
  if (ts.isCallExpression(node)) {
    const literalIndex = node.arguments.findIndex(
      (argument) =>
        ts.isStringLiteral(argument) ||
        ts.isNoSubstitutionTemplateLiteral(argument),
    );
    const placeholder =
      /WHERE[\s\S]*(?:(?:"[^"]+"|[A-Z_]\w*)\.)?(?:"id"|\bid\b)\s*(?:IN\s*\(\s*\$(\d+)|=\s*ANY\s*\(\s*\$(\d+))/iu.exec(
        sql,
      );
    const position = Number(placeholder?.[1] ?? placeholder?.[2]);
    const argument = node.arguments[literalIndex + position];
    return (
      literalIndex >= 0 &&
      Number.isSafeInteger(position) &&
      position > 0 &&
      argument !== undefined &&
      usesSymbol(checker, argument, value)
    );
  }
  return false;
}

function mediaRowLockPredicateUsesValue(
  checker: ts.TypeChecker,
  node: ts.Node,
  value: ts.Symbol,
): boolean {
  const sql = queryText(node);
  if (
    sql === undefined ||
    !/MediaAsset/iu.test(sql) ||
    !/FOR\s+(?:NO\s+KEY\s+)?UPDATE/iu.test(sql) ||
    !/WHERE[\s\S]*(?:(?:"[^"]+"|[A-Z_]\w*)\.)?(?:"id"|\bid\b)\s*=\s*/iu.test(
      sql,
    )
  ) {
    return false;
  }
  const template = queryTemplate(node);
  if (template !== undefined && ts.isTemplateExpression(template)) {
    let before = template.head.text;
    for (const span of template.templateSpans) {
      if (
        usesSymbol(checker, span.expression, value) &&
        /WHERE[\s\S]*(?:(?:"[^"]+"|[A-Z_]\w*)\.)?(?:"id"|\bid\b)\s*=\s*$/iu.test(
          before,
        )
      ) {
        return true;
      }
      before += `\${value}${span.literal.text}`;
    }
  }
  if (ts.isCallExpression(node)) {
    const literalIndex = node.arguments.findIndex(
      (argument) =>
        ts.isStringLiteral(argument) ||
        ts.isNoSubstitutionTemplateLiteral(argument),
    );
    const placeholder =
      /WHERE[\s\S]*(?:(?:"[^"]+"|[A-Z_]\w*)\.)?(?:"id"|\bid\b)\s*=\s*\$(\d+)/iu.exec(
        sql,
      );
    const position = Number(placeholder?.[1]);
    const argument = node.arguments[literalIndex + position];
    return (
      literalIndex >= 0 &&
      Number.isSafeInteger(position) &&
      position > 0 &&
      argument !== undefined &&
      usesSymbol(checker, argument, value)
    );
  }
  return false;
}

function advisoryLockKeyUsesValue(
  checker: ts.TypeChecker,
  node: ts.Node,
  value: ts.Symbol,
): boolean {
  const sql = queryText(node);
  if (sql === undefined || !/pg_advisory_xact_lock\s*\(/iu.test(sql)) {
    return false;
  }
  const template = queryTemplate(node);
  if (template !== undefined && ts.isTemplateExpression(template)) {
    let before = template.head.text;
    for (const span of template.templateSpans) {
      const open = before.lastIndexOf('pg_advisory_xact_lock');
      const keyPrefix = open < 0 ? '' : before.slice(open);
      if (
        usesSymbol(checker, span.expression, value) &&
        /pg_advisory_xact_lock\s*\([^)]*$/iu.test(keyPrefix)
      ) {
        return true;
      }
      before += `\${value}${span.literal.text}`;
    }
  }
  if (ts.isCallExpression(node)) {
    const literalIndex = node.arguments.findIndex(
      (argument) =>
        ts.isStringLiteral(argument) ||
        ts.isNoSubstitutionTemplateLiteral(argument),
    );
    const placeholder = /pg_advisory_xact_lock\s*\(\s*\$(\d+)/iu.exec(sql);
    const position = Number(placeholder?.[1]);
    const argument = node.arguments[literalIndex + position];
    return (
      literalIndex >= 0 &&
      Number.isSafeInteger(position) &&
      position > 0 &&
      argument !== undefined &&
      usesSymbol(checker, argument, value)
    );
  }
  return false;
}

function isAscendingAssetIdSort(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
): boolean {
  if (
    !ts.isPropertyAccessExpression(call.expression) ||
    !['sort', 'toSorted'].includes(call.expression.name.text)
  ) {
    return false;
  }
  const receiver = call.expression.expression;
  const receiverNamesAssetIds =
    /(?:asset|media)[A-Z_\d\w]*ids?|ids?[A-Z_\d\w]*(?:asset|media)/iu.test(
      receiver.getText(),
    );
  const comparator = call.arguments[0];
  if (comparator === undefined) {
    const element = checker.getIndexTypeOfType(
      checker.getTypeAtLocation(receiver),
      ts.IndexKind.Number,
    );
    return (
      receiverNamesAssetIds &&
      element !== undefined &&
      (element.flags & ts.TypeFlags.StringLike) !== 0
    );
  }
  if (
    (!ts.isArrowFunction(comparator) && !ts.isFunctionExpression(comparator)) ||
    comparator.parameters.length < 2 ||
    !ts.isIdentifier(comparator.parameters[0]?.name) ||
    !ts.isIdentifier(comparator.parameters[1]?.name)
  ) {
    return false;
  }
  const left = resolvedSymbol(checker, comparator.parameters[0].name);
  const right = resolvedSymbol(checker, comparator.parameters[1].name);
  if (left === undefined || right === undefined) return false;
  const body = comparator.body;
  if (
    ts.isCallExpression(body) &&
    ts.isPropertyAccessExpression(body.expression) &&
    body.expression.name.text === 'localeCompare' &&
    body.arguments[0] !== undefined
  ) {
    const leftValue = body.expression.expression;
    const rightValue = body.arguments[0];
    const leftPath = leftValue
      .getText()
      .replace(new RegExp(`^${comparator.parameters[0].name.text}`), 'item');
    const rightPath = rightValue
      .getText()
      .replace(new RegExp(`^${comparator.parameters[1].name.text}`), 'item');
    return (
      usesSymbol(checker, leftValue, left) &&
      !usesSymbol(checker, leftValue, right) &&
      usesSymbol(checker, rightValue, right) &&
      !usesSymbol(checker, rightValue, left) &&
      leftPath === rightPath &&
      (receiverNamesAssetIds || /asset|media|\.id\b/iu.test(leftPath))
    );
  }
  if (
    ts.isBinaryExpression(body) &&
    body.operatorToken.kind === ts.SyntaxKind.MinusToken
  ) {
    return (
      usesSymbol(checker, body.left, left) &&
      !usesSymbol(checker, body.left, right) &&
      usesSymbol(checker, body.right, right) &&
      !usesSymbol(checker, body.right, left) &&
      /asset|media|\.id\b/iu.test(body.getText())
    );
  }
  return false;
}

function usesSymbol(
  checker: ts.TypeChecker,
  node: ts.Node,
  symbol: ts.Symbol,
): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (
      ts.isIdentifier(candidate) &&
      resolvedSymbol(checker, candidate) === symbol
    ) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

function bindingSymbols(
  checker: ts.TypeChecker,
  name: ts.BindingName,
): ts.Symbol[] {
  if (ts.isIdentifier(name)) {
    const symbol = resolvedSymbol(checker, name);
    return symbol === undefined ? [] : [symbol];
  }
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element)
      ? []
      : bindingSymbols(checker, element.name),
  );
}

function propagatedValueStates(
  checker: ts.TypeChecker,
  roots: readonly ts.SignatureDeclaration[],
  sourceParameterIndexes: readonly number[],
  moduleRoot: string,
): Map<ts.SignatureDeclaration, Set<ts.Symbol>> {
  const states = new Map<ts.SignatureDeclaration, Set<ts.Symbol>>();
  const queue: Array<{
    readonly declaration: ts.SignatureDeclaration;
    readonly value: ts.Symbol;
  }> = [];
  for (const root of roots) {
    for (const index of sourceParameterIndexes) {
      const parameter = root.parameters[index];
      if (parameter === undefined) continue;
      for (const value of bindingSymbols(checker, parameter.name)) {
        queue.push({ declaration: root, value });
      }
    }
  }
  while (queue.length > 0 && states.size < 80) {
    const state = queue.shift();
    if (state === undefined) continue;
    const values = states.get(state.declaration) ?? new Set<ts.Symbol>();
    if (values.has(state.value)) continue;
    values.add(state.value);
    states.set(state.declaration, values);
    const enqueueLocal = (name: ts.BindingName): void => {
      for (const value of bindingSymbols(checker, name)) {
        queue.push({ declaration: state.declaration, value });
      }
    };
    const visit = (node: ts.Node): void => {
      if (
        node !== state.declaration &&
        (ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node) ||
          ts.isClassDeclaration(node))
      ) {
        return;
      }
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer !== undefined &&
        usesSymbol(checker, node.initializer, state.value)
      ) {
        enqueueLocal(node.name);
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        usesSymbol(checker, node.right, state.value) &&
        ts.isIdentifier(node.left)
      ) {
        enqueueLocal(node.left);
      }
      if (ts.isCallExpression(node)) {
        const nested = checker.getResolvedSignature(node)?.declaration;
        if (
          nested !== undefined &&
          nested.getSourceFile().fileName.startsWith(moduleRoot)
        ) {
          node.arguments.forEach((argument, index) => {
            if (!usesSymbol(checker, argument, state.value)) return;
            const parameter = nested.parameters[index];
            if (parameter === undefined) return;
            for (const value of bindingSymbols(checker, parameter.name)) {
              queue.push({ declaration: nested, value });
            }
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(state.declaration);
  }
  return states;
}

function parameterCarriesAssetIds(
  checker: ts.TypeChecker,
  parameter: ts.ParameterDeclaration,
): boolean {
  if (
    /(?:asset|media).*(?:ids?|references?)/iu.test(parameter.name.getText())
  ) {
    return true;
  }
  const type = checker.getTypeAtLocation(parameter);
  return type
    .getProperties()
    .some((property) =>
      /(?:asset|media).*(?:ids?|references?)|referenced.*(?:asset|media)/iu.test(
        property.name,
      ),
    );
}

function parameterCarriesProjectId(
  checker: ts.TypeChecker,
  parameter: ts.ParameterDeclaration,
): boolean {
  if (/projectId|project/iu.test(parameter.name.getText())) return true;
  return checker
    .getTypeAtLocation(parameter)
    .getProperties()
    .some((property) => property.name === 'projectId');
}

function reachableMatchingNodes(
  checker: ts.TypeChecker,
  rootCall: ts.CallExpression,
  sourceValue: ts.Symbol,
  moduleRoot: string,
  matches: (node: ts.Node, value: ts.Symbol) => boolean,
): Set<ts.Node> {
  const matchesFound = new Set<ts.Node>();
  if (
    matches(rootCall, sourceValue) &&
    usesSymbol(checker, rootCall, sourceValue)
  ) {
    matchesFound.add(rootCall);
  }
  const signature = checker.getResolvedSignature(rootCall)?.declaration;
  if (signature === undefined) return matchesFound;
  const queue: { declaration: ts.SignatureDeclaration; value: ts.Symbol }[] =
    [];
  rootCall.arguments.forEach((argument, index) => {
    if (!usesSymbol(checker, argument, sourceValue)) return;
    const parameter = signature.parameters[index];
    const value =
      parameter === undefined
        ? undefined
        : resolvedSymbol(checker, parameter.name);
    if (value !== undefined) queue.push({ declaration: signature, value });
  });
  const visited = new Map<ts.SignatureDeclaration, Set<ts.Symbol>>();
  while (queue.length > 0 && visited.size < 80) {
    const state = queue.shift();
    if (state === undefined) continue;
    const values = visited.get(state.declaration) ?? new Set<ts.Symbol>();
    if (values.has(state.value)) continue;
    values.add(state.value);
    visited.set(state.declaration, values);
    const visit = (node: ts.Node): void => {
      if (
        matches(node, state.value) &&
        usesSymbol(checker, node, state.value)
      ) {
        matchesFound.add(node);
      }
      if (ts.isCallExpression(node)) {
        const nested = checker.getResolvedSignature(node)?.declaration;
        if (
          nested !== undefined &&
          nested.getSourceFile().fileName.startsWith(moduleRoot)
        ) {
          node.arguments.forEach((argument, index) => {
            if (!usesSymbol(checker, argument, state.value)) return;
            const parameter = nested.parameters[index];
            const value =
              parameter === undefined
                ? undefined
                : resolvedSymbol(checker, parameter.name);
            if (value !== undefined) queue.push({ declaration: nested, value });
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(state.declaration);
  }
  return matchesFound;
}

function argumentReachesMatchingNode(
  checker: ts.TypeChecker,
  rootCall: ts.CallExpression,
  sourceValue: ts.Symbol,
  moduleRoot: string,
  matches: (node: ts.Node, value: ts.Symbol) => boolean,
): boolean {
  return (
    reachableMatchingNodes(checker, rootCall, sourceValue, moduleRoot, matches)
      .size > 0
  );
}

function declarationValueReachesMatchingNode(
  checker: ts.TypeChecker,
  declaration: ts.SignatureDeclaration,
  sourceValue: ts.Symbol,
  moduleRoot: string,
  matches: (node: ts.Node, value: ts.Symbol) => boolean,
): boolean {
  const queue = [{ declaration, value: sourceValue }];
  const visited = new Map<ts.SignatureDeclaration, Set<ts.Symbol>>();
  while (queue.length > 0 && visited.size < 80) {
    const state = queue.shift();
    if (state === undefined) continue;
    const values = visited.get(state.declaration) ?? new Set<ts.Symbol>();
    if (values.has(state.value)) continue;
    values.add(state.value);
    visited.set(state.declaration, values);
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (matches(node, state.value)) {
        found = true;
        return;
      }
      if (ts.isCallExpression(node)) {
        const nested = checker.getResolvedSignature(node)?.declaration;
        if (
          nested !== undefined &&
          nested.getSourceFile().fileName.startsWith(moduleRoot)
        ) {
          node.arguments.forEach((argument, index) => {
            if (!usesSymbol(checker, argument, state.value)) return;
            const parameter = nested.parameters[index];
            const value =
              parameter === undefined
                ? undefined
                : resolvedSymbol(checker, parameter.name);
            if (value !== undefined) queue.push({ declaration: nested, value });
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(state.declaration);
    if (found) return true;
  }
  return false;
}

function hasSortedConflictingMediaLocks(
  program: ts.Program,
  implementation: readonly ts.SignatureDeclaration[],
  moduleRoot: string,
  referencedParameterIndexes?: readonly number[],
): boolean {
  const checker = program.getTypeChecker();
  const sourceIndexes =
    referencedParameterIndexes ??
    implementation[0]?.parameters.flatMap((parameter, index) =>
      parameterCarriesAssetIds(checker, parameter) ? [index] : [],
    ) ??
    [];
  if (sourceIndexes.length === 0) return false;
  const states = propagatedValueStates(
    checker,
    implementation,
    sourceIndexes,
    moduleRoot,
  );
  for (const [declaration, values] of states) {
    for (const value of values) {
      if (
        declarationValueReachesMatchingNode(
          checker,
          declaration,
          value,
          moduleRoot,
          (node, current) =>
            mediaSetLockPredicateUsesValue(checker, node, current),
        )
      ) {
        return true;
      }
    }
  }

  const sortedSymbols = new Set<ts.Symbol>();
  const sortedCalls = new Set<ts.CallExpression>();
  for (const [root, values] of states) {
    const visitSorts = (node: ts.Node): void => {
      const receiver =
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
          ? node.expression.expression
          : undefined;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['sort', 'toSorted'].includes(node.expression.name.text) &&
        isAscendingAssetIdSort(checker, node) &&
        receiver !== undefined &&
        [...values].some((value) => usesSymbol(checker, receiver, value))
      ) {
        sortedCalls.add(node);
        const declaration = ts.isVariableDeclaration(node.parent)
          ? node.parent
          : ts.isVariableDeclaration(node.parent.parent)
            ? node.parent.parent
            : undefined;
        if (declaration !== undefined && ts.isIdentifier(declaration.name)) {
          const symbol = resolvedSymbol(checker, declaration.name);
          if (symbol !== undefined) sortedSymbols.add(symbol);
        }
        if (node.expression.name.text === 'sort') {
          const receiver = resolvedSymbol(checker, node.expression.expression);
          if (receiver !== undefined) sortedSymbols.add(receiver);
        }
      }
      ts.forEachChild(node, visitSorts);
    };
    visitSorts(root);
  }
  const isSortedExpression = (expression: ts.Expression): boolean => {
    if (ts.isCallExpression(expression) && sortedCalls.has(expression)) {
      return true;
    }
    const symbol = resolvedSymbol(checker, expression);
    return symbol !== undefined && sortedSymbols.has(symbol);
  };
  const bodyLocksCurrent = (body: ts.Node, item: ts.Symbol): boolean => {
    let locks = false;
    const visit = (node: ts.Node): void => {
      if (locks) return;
      if (
        (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) &&
        usesSymbol(checker, node, item)
      ) {
        if (mediaRowLockPredicateUsesValue(checker, node, item)) {
          locks = true;
          return;
        }
        if (ts.isCallExpression(node)) {
          if (
            argumentReachesMatchingNode(
              checker,
              node,
              item,
              moduleRoot,
              (candidate, current) =>
                mediaRowLockPredicateUsesValue(checker, candidate, current),
            )
          ) {
            locks = true;
            return;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
    return locks;
  };
  for (const root of states.keys()) {
    let sequentialLock = false;
    const visitLoops = (node: ts.Node): void => {
      if (sequentialLock) return;
      if (
        ts.isForOfStatement(node) &&
        isSortedExpression(node.expression) &&
        ts.isVariableDeclarationList(node.initializer)
      ) {
        const item = node.initializer.declarations[0]?.name;
        const symbol =
          item !== undefined && ts.isIdentifier(item)
            ? resolvedSymbol(checker, item)
            : undefined;
        if (symbol !== undefined && bodyLocksCurrent(node.statement, symbol)) {
          sequentialLock = true;
          return;
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['forEach', 'map'].includes(node.expression.name.text) &&
        isSortedExpression(node.expression.expression)
      ) {
        const callback = node.arguments[0];
        if (
          callback !== undefined &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        ) {
          const item = callback.parameters[0]?.name;
          const symbol =
            item !== undefined && ts.isIdentifier(item)
              ? resolvedSymbol(checker, item)
              : undefined;
          if (symbol !== undefined && bodyLocksCurrent(callback.body, symbol)) {
            sequentialLock = true;
            return;
          }
        }
      }
      ts.forEachChild(node, visitLoops);
    };
    visitLoops(root);
    if (sequentialLock) return true;
  }
  return false;
}

function receiverInjectedTokens(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
): ts.Symbol[] {
  if (!ts.isPropertyAccessExpression(call.expression)) return [];
  const tokens = new Set<ts.Symbol>();
  const queue: ts.Node[] = [call.expression.expression];
  const visited = new Set<ts.Node>();
  while (queue.length > 0 && visited.size < 40) {
    const current = queue.shift();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const declaration of resolvedSymbol(checker, current)?.declarations ??
      []) {
      if (ts.canHaveDecorators(declaration)) {
        for (const decorator of ts.getDecorators(declaration) ?? []) {
          if (!ts.isCallExpression(decorator.expression)) continue;
          const injected = decorator.expression.arguments[0];
          const token =
            injected === undefined
              ? undefined
              : resolvedSymbol(checker, injected);
          if (token !== undefined) tokens.add(token);
        }
      }
      if ('type' in declaration && declaration.type !== undefined) {
        const type = checker.getTypeAtLocation(declaration.type);
        const token = type.aliasSymbol ?? type.getSymbol();
        if (token !== undefined) tokens.add(token);
      }
      if (
        (ts.isPropertyDeclaration(declaration) ||
          ts.isVariableDeclaration(declaration) ||
          ts.isParameter(declaration)) &&
        declaration.initializer !== undefined
      ) {
        queue.push(declaration.initializer);
      }
    }
    ts.forEachChild(current, (child) => queue.push(child));
  }
  return [...tokens];
}

function receiverUsesInjectedToken(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  token: ts.Symbol,
): boolean {
  return receiverInjectedTokens(checker, call).includes(token);
}

function callAcceptsExpectedTransactionContext(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  expected: ts.Symbol,
  transactionFile: string,
): boolean {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (declaration === undefined) return false;
  const parameter = call.arguments.some((argument, index) => {
    if (!usesSymbol(checker, argument, expected)) return false;
    const parameter = declaration.parameters[index];
    if (parameter === undefined) return false;
    const type = checker.getTypeAtLocation(parameter);
    return declaredIn(type.aliasSymbol ?? type.getSymbol(), transactionFile);
  });
  if (parameter) return true;
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const receiver = call.expression.expression;
  if (!usesSymbol(checker, receiver, expected)) return false;
  const receiverType = checker.getTypeAtLocation(receiver);
  return declaredIn(
    receiverType.aliasSymbol ?? receiverType.getSymbol(),
    transactionFile,
  );
}

function callbackIsFedByTransactionRunner(
  checker: ts.TypeChecker,
  outerCall: ts.CallExpression,
  propertyName: string | undefined,
  transactionFile: string,
): boolean {
  const declaration = checker.getResolvedSignature(outerCall)?.declaration;
  if (declaration === undefined) return false;
  if (
    resolve(declaration.getSourceFile().fileName) === transactionFile &&
    ts.isClassDeclaration(declaration.parent) &&
    declaration.parent.name?.text === 'TransactionRunner'
  ) {
    return propertyName === undefined;
  }
  if (propertyName === undefined) return false;
  const outerArgumentIndex = outerCall.arguments.findIndex((argument) => {
    if (!ts.isObjectLiteralExpression(argument)) return false;
    return argument.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText(property.getSourceFile()) === propertyName,
    );
  });
  const inputParameter = declaration.parameters[outerArgumentIndex];
  const inputValue =
    inputParameter === undefined
      ? undefined
      : resolvedSymbol(checker, inputParameter.name);
  if (inputValue === undefined) return false;
  let proven = false;
  const visit = (node: ts.Node): void => {
    if (proven) return;
    if (ts.isCallExpression(node)) {
      const runnerDeclaration = checker.getResolvedSignature(node)?.declaration;
      if (
        runnerDeclaration !== undefined &&
        resolve(runnerDeclaration.getSourceFile().fileName) === transactionFile
      ) {
        for (const argument of node.arguments) {
          if (
            !ts.isArrowFunction(argument) &&
            !ts.isFunctionExpression(argument)
          ) {
            continue;
          }
          const context = argument.parameters[0];
          const contextValue =
            context === undefined
              ? undefined
              : resolvedSymbol(checker, context.name);
          if (contextValue === undefined) continue;
          const nestedVisit = (candidate: ts.Node): void => {
            if (proven) return;
            if (
              ts.isCallExpression(candidate) &&
              ts.isPropertyAccessExpression(candidate.expression) &&
              candidate.expression.name.text === propertyName &&
              usesSymbol(
                checker,
                candidate.expression.expression,
                inputValue,
              ) &&
              candidate.arguments.some((value) =>
                usesSymbol(checker, value, contextValue),
              )
            ) {
              proven = true;
              return;
            }
            ts.forEachChild(candidate, nestedVisit);
          };
          nestedVisit(argument);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  return proven;
}

function transactionCallbackValues(
  checker: ts.TypeChecker,
  entry: ts.MethodDeclaration,
  transactionFile: string,
  moduleRoot: string,
): Set<ts.Symbol> {
  const values = new Set<ts.Symbol>();
  const visit = (node: ts.Node): void => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      let current: ts.Node = node;
      let propertyName: string | undefined;
      while (
        ts.isPropertyAssignment(current.parent) ||
        ts.isObjectLiteralExpression(current.parent) ||
        ts.isParenthesizedExpression(current.parent)
      ) {
        current = current.parent;
        if (ts.isPropertyAssignment(current)) {
          propertyName = current.name.getText(current.getSourceFile());
        }
      }
      const outerCall = ts.isCallExpression(current.parent)
        ? current.parent
        : undefined;
      if (
        outerCall !== undefined &&
        callbackIsFedByTransactionRunner(
          checker,
          outerCall,
          propertyName,
          transactionFile,
        )
      ) {
        const indexes = node.parameters.flatMap((parameter, index) => {
          const type = checker.getTypeAtLocation(parameter);
          return declaredIn(
            type.aliasSymbol ?? type.getSymbol(),
            transactionFile,
          )
            ? [index]
            : [];
        });
        const states = propagatedValueStates(
          checker,
          [node],
          indexes,
          moduleRoot,
        );
        for (const stateValues of states.values()) {
          for (const value of stateValues) values.add(value);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(entry);
  return values;
}

function operationProjectValues(
  checker: ts.TypeChecker,
  entry: ts.MethodDeclaration,
  moduleRoot: string,
): Set<ts.Symbol> {
  const indexes = entry.parameters.flatMap((parameter, index) =>
    parameterCarriesProjectId(checker, parameter) ? [index] : [],
  );
  const values = new Set<ts.Symbol>();
  const states = propagatedValueStates(checker, [entry], indexes, moduleRoot);
  for (const stateValues of states.values()) {
    for (const value of stateValues) values.add(value);
  }
  return values;
}

function transactionBearingNodeUsesValue(
  checker: ts.TypeChecker,
  node: ts.Node,
  value: ts.Symbol,
  transactionFile: string,
): boolean {
  if (ts.isTaggedTemplateExpression(node)) {
    return usesSymbol(checker, node.tag, value);
  }
  if (!ts.isCallExpression(node)) return false;
  if (usesSymbol(checker, node.expression, value)) return true;
  const declaration = checker.getResolvedSignature(node)?.declaration;
  if (declaration === undefined) return false;
  return node.arguments.some((argument, index) => {
    if (!usesSymbol(checker, argument, value)) return false;
    const parameter = declaration.parameters[index];
    if (parameter === undefined) return false;
    const type = checker.getTypeAtLocation(parameter);
    return declaredIn(type.aliasSymbol ?? type.getSymbol(), transactionFile);
  });
}

function localMutationEvidence(
  checker: ts.TypeChecker,
  node: ts.Node,
  kind: 'media-mutation' | 'sites-write',
): boolean {
  if (!ts.isCallExpression(node) && !ts.isTaggedTemplateExpression(node)) {
    return false;
  }
  const declaration = ts.isCallExpression(node)
    ? checker.getResolvedSignature(node)?.declaration
    : undefined;
  const parentName =
    declaration !== undefined && ts.isClassDeclaration(declaration.parent)
      ? declaration.parent.name?.text
      : undefined;
  const declarationName =
    declaration !== undefined &&
    (ts.isMethodDeclaration(declaration) ||
      ts.isFunctionDeclaration(declaration))
      ? declaration.name?.getText(declaration.getSourceFile())
      : undefined;
  const evidence = [node.getText(), declarationName, parentName].join(' ');
  return kind === 'sites-write'
    ? /(?:ProjectRevision|Release|draftVersion|ProjectRepository)[\s\S]*(?:create|update|insert|write)|(?:create|update|insert|write)[\s\S]*(?:ProjectRevision|Release|draftVersion|ProjectRepository)/iu.test(
        evidence,
      )
    : /(?:MediaAsset|deletionMarkedAt|DELETING|MediaRepository)[\s\S]*(?:delete|update|mark)|(?:delete|update|mark)[\s\S]*(?:MediaAsset|deletionMarkedAt|DELETING|MediaRepository)/iu.test(
        evidence,
      );
}

function callsReachSameNode(
  checker: ts.TypeChecker,
  root: ts.CallExpression,
  leftValues: ReadonlySet<ts.Symbol>,
  rightValues: ReadonlySet<ts.Symbol>,
  moduleRoot: string,
  leftMatches: (node: ts.Node, value: ts.Symbol) => boolean,
  rightMatches: (node: ts.Node, value: ts.Symbol) => boolean,
): boolean {
  const leftNodes = new Set<ts.Node>();
  for (const value of leftValues) {
    for (const node of reachableMatchingNodes(
      checker,
      root,
      value,
      moduleRoot,
      leftMatches,
    )) {
      leftNodes.add(node);
    }
  }
  if (leftNodes.size === 0) return false;
  for (const value of rightValues) {
    for (const node of reachableMatchingNodes(
      checker,
      root,
      value,
      moduleRoot,
      rightMatches,
    )) {
      if (leftNodes.has(node)) return true;
    }
  }
  return false;
}

function orderedCrossPortFlow(
  program: ts.Program,
  input: {
    readonly file: string;
    readonly owner: 'media' | 'sites';
    readonly terminalKind: 'media-mutation' | 'sites-write';
  },
): boolean {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(input.file);
  if (source === undefined) return false;
  const ownerPublic = resolve(
    sourceRoot,
    `modules/${input.owner}/application/public.ts`,
  );
  const transactionFile = resolve(
    sourceRoot,
    'shared/database/transaction-runner.ts',
  );
  const ownerModuleRoot = resolve(sourceRoot, `modules/${input.owner}`);
  const publicSource = program.getSourceFile(ownerPublic);
  const publicTokens = new Set<ts.Symbol>();
  for (const statement of publicSource?.statements ?? []) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        declaration.initializer !== undefined &&
        ts.isCallExpression(declaration.initializer) &&
        declaration.initializer.expression.getText(publicSource) === 'Symbol'
      ) {
        const symbol = resolvedSymbol(checker, declaration.name);
        if (symbol !== undefined) publicTokens.add(symbol);
      }
    }
  }

  const entries = registeredOperationEntries(program, input.file);
  if (entries.length === 0) return false;
  const entryHasFlow = (entry: ts.MethodDeclaration): boolean => {
    const operationRoot = input.file.includes('/sites/')
      ? sitesModuleRoot
      : mediaModuleRoot;
    const calls = operationExecutionTrace(program, entry);
    const contextValues = transactionCallbackValues(
      checker,
      entry,
      transactionFile,
      operationRoot,
    );
    const projectValues = operationProjectValues(checker, entry, operationRoot);
    if (contextValues.size === 0 || projectValues.size === 0) return false;
    const port = calls
      .map((call) => {
        const signature = checker.getResolvedSignature(call);
        const declaration = signature?.declaration;
        const argument = call.arguments[0];
        const parameter = declaration?.parameters[0];
        if (
          declaration === undefined ||
          argument === undefined ||
          parameter === undefined ||
          resolve(declaration.getSourceFile().fileName) !== ownerPublic
        ) {
          return undefined;
        }
        const contextType = checker.getTypeAtLocation(parameter);
        const contextSymbol =
          contextType.aliasSymbol ?? contextType.getSymbol();
        if (
          !declaredIn(contextSymbol, transactionFile) ||
          !checker.isTypeAssignableTo(
            checker.getTypeAtLocation(argument),
            contextType,
          )
        ) {
          return undefined;
        }
        const binding = registeredPortBinding(
          program,
          ownerModuleRoot,
          publicTokens,
          declaration,
        );
        const contextValue = [...contextValues].find((value) =>
          usesSymbol(checker, argument, value),
        );
        const referencedParameterIndexes = declaration.parameters.flatMap(
          (candidate, index) =>
            index > 0 &&
            call.arguments[index] !== undefined &&
            parameterCarriesAssetIds(checker, candidate)
              ? [index]
              : [],
        );
        return binding === undefined ||
          contextValue === undefined ||
          (input.owner === 'media' &&
            referencedParameterIndexes.length === 0) ||
          !receiverUsesInjectedToken(checker, call, binding.token)
          ? undefined
          : { binding, call, contextValue, referencedParameterIndexes };
      })
      .find((candidate) => candidate !== undefined);
    if (port !== undefined) {
      const portCall = port.call;
      const portPosition = calls.indexOf(portCall);
      if (
        input.owner === 'media' &&
        !port.binding.implementationAlternatives.every((implementation) =>
          hasSortedConflictingMediaLocks(
            program,
            implementation,
            ownerModuleRoot,
            port.referencedParameterIndexes,
          ),
        )
      ) {
        return false;
      }
      const lock = calls.find((call, index) => {
        if (index >= portPosition) return false;
        return callsReachSameNode(
          checker,
          call,
          projectValues,
          contextValues,
          operationRoot,
          (node, current) => advisoryLockKeyUsesValue(checker, node, current),
          (node, current) =>
            /pg_advisory_xact_lock\s*\(/iu.test(queryText(node) ?? '') &&
            transactionBearingNodeUsesValue(
              checker,
              node,
              current,
              transactionFile,
            ),
        );
      });
      const terminal = calls.find((call, index) => {
        if (index <= portPosition) return false;
        return [...contextValues].some(
          (value) =>
            reachableMatchingNodes(
              checker,
              call,
              value,
              operationRoot,
              (node, current) =>
                localMutationEvidence(checker, node, input.terminalKind) &&
                transactionBearingNodeUsesValue(
                  checker,
                  node,
                  current,
                  transactionFile,
                ),
            ).size > 0,
        );
      });
      return lock !== undefined && terminal !== undefined;
    }
    return false;
  };
  return entries.some((alternative) => alternative.every(entryHasFlow));
}

describe('transactional managed-media/sites application boundary', () => {
  const program = createSourceProgram();
  const mediaFiles = typescriptFiles(mediaApplicationRoot);

  it('does not combine unrelated SQL fragments into sorted conflicting-lock evidence', () => {
    const unsafe = ts.createSourceFile(
      'unsafe.ts',
      `repository.query('SELECT id FROM "MediaAsset" ORDER BY id');
       repository.query('SELECT id FROM "MediaAsset" FOR UPDATE');`,
      ts.ScriptTarget.Latest,
      true,
    );
    const safe = ts.createSourceFile(
      'safe.ts',
      `repository.query('SELECT id FROM "MediaAsset" ORDER BY "asset"."id" FOR UPDATE');`,
      ts.ScriptTarget.Latest,
      true,
    );
    const projectId = ts.createSourceFile(
      'project-id.ts',
      `repository.query('SELECT projectId FROM "MediaAsset" ORDER BY projectId FOR UPDATE');`,
      ts.ScriptTarget.Latest,
      true,
    );
    const secondaryId = ts.createSourceFile(
      'secondary-id.ts',
      `repository.query('SELECT id FROM "MediaAsset" ORDER BY createdAt, id FOR UPDATE');`,
      ts.ScriptTarget.Latest,
      true,
    );
    expect(hasDatabaseSortedMediaLock(unsafe)).toBe(false);
    expect(hasDatabaseSortedMediaLock(projectId)).toBe(false);
    expect(hasDatabaseSortedMediaLock(secondaryId)).toBe(false);
    expect(hasDatabaseSortedMediaLock(safe)).toBe(true);
  });

  it('examines factory return branches rather than unused constructed values', () => {
    const source = ts.createSourceFile(
      'factory.ts',
      `const factory = () => {
         new UnusedImplementation();
         return choose ? new FirstImplementation() : new SecondImplementation();
       };`,
      ts.ScriptTarget.Latest,
      true,
    );
    let factory: ts.ArrowFunction | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isArrowFunction(node)) factory = node;
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (factory === undefined) throw new Error('Factory fixture is invalid');
    const returned = factoryReturnedExpressions(factory);
    expect(returned).toHaveLength(1);
    expect(returned[0]?.getText(source)).toContain('FirstImplementation');
    expect(returned[0]?.getText(source)).toContain('SecondImplementation');
    expect(returned[0]?.getText(source)).not.toContain('UnusedImplementation');
  });

  it('registers only classes reached by actual factory return expressions', () => {
    const fixture = createAnalyzerFixture(`
      class UnusedOperation { execute(): void {} }
      class ReturnedOperation { execute(): void {} }
      const operationFactory = () => {
        new UnusedOperation();
        return new ReturnedOperation();
      };
    `);
    const checker = fixture.program.getTypeChecker();
    let factory: ts.Expression | undefined;
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'operationFactory'
      ) {
        factory = node.name;
      }
      ts.forEachChild(node, visit);
    };
    visit(fixture.source);
    if (factory === undefined) throw new Error('Factory fixture is invalid');
    expect(
      actualFactoryClassSymbols(checker, factory).map(({ name }) => name),
    ).toEqual(['ReturnedOperation']);
  });

  it('roots an interface-typed API call in every factory-return operation class', () => {
    const fixture = createAnalyzerFixture(
      `
        declare function Inject(token: symbol): any;
        const OPERATION = Symbol('operation');
        interface Operation { execute(): void }
        class FirstOperation implements Operation { execute(): void {} }
        class SecondOperation implements Operation { execute(): void {} }
        const factory = () => choose ? new FirstOperation() : new SecondOperation();
        const moduleMetadata = { providers: [{ provide: OPERATION, useFactory: factory }] };
        class Controller {
          constructor(@Inject(OPERATION) private readonly operation: Operation) {}
          invoke(): void { this.operation.execute(); }
        }
        void moduleMetadata;
      `,
      '/fixture/api/factory-operation.ts',
    );
    const alternatives = registeredOperationEntries(
      fixture.program,
      fixture.source.fileName,
    );
    expect(
      alternatives.map((methods) =>
        methods.map(
          (method) =>
            (method.parent as ts.ClassDeclaration).name?.text ?? 'anonymous',
        ),
      ),
    ).toContainEqual(['FirstOperation', 'SecondOperation']);
  });

  it('does not accept a concrete receiver singleton when its token resolves factory alternatives', () => {
    const fixture = createAnalyzerFixture(
      `
        declare function Inject(token: symbol): any;
        const OPERATION = Symbol('operation');
        class SafeOperation { execute(): void {} }
        class UnsafeOperation { execute(): void {} }
        const factory = () => choose ? new SafeOperation() : new UnsafeOperation();
        const moduleMetadata = { providers: [{ provide: OPERATION, useFactory: factory }] };
        class Controller {
          constructor(@Inject(OPERATION) private readonly operation: SafeOperation) {}
          invoke(): void { this.operation.execute(); }
        }
        void moduleMetadata;
      `,
      '/fixture/api/concrete-factory-operation.ts',
    );
    const alternatives = registeredOperationEntries(
      fixture.program,
      fixture.source.fileName,
    ).map((methods) =>
      methods.map(
        (method) =>
          (method.parent as ts.ClassDeclaration).name?.text ?? 'anonymous',
      ),
    );
    expect(alternatives).toContainEqual(['SafeOperation', 'UnsafeOperation']);
    expect(alternatives).not.toContainEqual(['SafeOperation']);
  });

  it('follows useExisting through a class token backed by every factory alternative', () => {
    const fixture = createAnalyzerFixture(
      `
        declare function Inject(token: symbol): any;
        const OPERATION = Symbol('operation');
        class SafeOperation { execute(): void {} }
        class UnsafeOperation { execute(): void {} }
        const factory = () => choose ? new SafeOperation() : new UnsafeOperation();
        const moduleMetadata = {
          providers: [
            { provide: OPERATION, useExisting: SafeOperation },
            { provide: SafeOperation, useFactory: factory },
          ],
        };
        class Controller {
          constructor(@Inject(OPERATION) private readonly operation: SafeOperation) {}
          invoke(): void { this.operation.execute(); }
        }
        void moduleMetadata;
      `,
      '/fixture/api/use-existing-factory-operation.ts',
    );
    const alternatives = registeredOperationEntries(
      fixture.program,
      fixture.source.fileName,
    ).map((methods) =>
      methods.map(
        (method) =>
          (method.parent as ts.ClassDeclaration).name?.text ?? 'anonymous',
      ),
    );
    expect(alternatives).toContainEqual(['SafeOperation', 'UnsafeOperation']);
    expect(alternatives).not.toContainEqual(['SafeOperation']);
  });

  it('traces only object callbacks that the resolved callee invokes', () => {
    const fixture = createAnalyzerFixture(`
      declare function dead(): void;
      declare function live(): void;
      function ignores(input: { command: () => void }): void { void input; }
      function invokes(input: { command: () => void }): void { delegate(input); }
      function delegate(input: { command: () => void }): void { input.command(); }
      function entry(): void {
        ignores({ command: () => dead() });
        invokes({ command: () => live() });
      }
    `);
    const checker = fixture.program.getTypeChecker();
    const entry = fixture.source.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === 'entry',
    );
    if (entry === undefined) throw new Error('Callback fixture is invalid');
    const calls = executableCalls(checker, entry).map((call) => call.getText());
    expect(calls).toContain('live()');
    expect(calls).not.toContain('dead()');
  });

  it('requires every factory implementation alternative to lock asset ids in ascending order', () => {
    const fixture = createAnalyzerFixture(`
      declare function query(sql: TemplateStringsArray, ...values: unknown[]): void;
      function safe(assetIds: string[]): void {
        const orderedAssetIds = assetIds.toSorted((left, right) => left.localeCompare(right));
        for (const assetId of orderedAssetIds) {
          query\`SELECT id FROM "MediaAsset" WHERE id = \${assetId} FOR UPDATE\`;
        }
      }
      function unsafe(assetIds: string[]): void {
        const orderedAssetIds = assetIds.toSorted(() => 0);
        for (const assetId of orderedAssetIds) {
          query\`SELECT id FROM "MediaAsset" WHERE id = \${assetId} FOR UPDATE\`;
        }
      }
      function ignored(assetIds: string[]): void {
        const orderedAssetIds = assetIds.toSorted((left, right) => left.localeCompare(right));
        for (const assetId of orderedAssetIds) lockIgnoringAssetId(assetId);
      }
      function lockIgnoringAssetId(_assetId: string): void {
        query\`SELECT id FROM "MediaAsset" WHERE id = 'constant' FOR UPDATE\`;
      }
      function ignoresPortInput(input: { referencedAssetIds: string[] }): void {
        void input;
        const mediaAssetIds = ['local-constant'];
        const orderedAssetIds = mediaAssetIds.toSorted((left, right) => left.localeCompare(right));
        for (const assetId of orderedAssetIds) {
          query\`SELECT id FROM "MediaAsset" WHERE id = \${assetId} FOR UPDATE\`;
        }
      }
    `);
    const functions = new Map<string, ts.FunctionDeclaration>();
    for (const statement of fixture.source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
        functions.set(statement.name.text, statement);
      }
    }
    const safe = functions.get('safe');
    const unsafe = functions.get('unsafe');
    const ignored = functions.get('ignored');
    const ignoresPortInput = functions.get('ignoresPortInput');
    if (
      safe === undefined ||
      unsafe === undefined ||
      ignored === undefined ||
      ignoresPortInput === undefined
    ) {
      throw new Error('Sorted-lock fixture is invalid');
    }
    const alternatives = [[safe], [unsafe]] as const;
    expect(
      alternatives.every((alternative) =>
        hasSortedConflictingMediaLocks(
          fixture.program,
          alternative,
          resolve('/'),
        ),
      ),
    ).toBe(false);
    expect(
      hasSortedConflictingMediaLocks(fixture.program, [safe], resolve('/')),
    ).toBe(true);
    expect(
      hasSortedConflictingMediaLocks(fixture.program, [ignored], resolve('/')),
    ).toBe(false);
    expect(
      hasSortedConflictingMediaLocks(
        fixture.program,
        [ignoresPortInput],
        resolve('/'),
        [0],
      ),
    ).toBe(false);
  });

  it('binds referenced asset ids to the same sorted MediaAsset row predicate', () => {
    const fixture = createAnalyzerFixture(`
      declare function query(sql: TemplateStringsArray, ...values: unknown[]): void;
      function good(referencedAssetIds: string[]): void {
        query\`SELECT id FROM "MediaAsset" WHERE id = ANY(\${referencedAssetIds}) ORDER BY id FOR UPDATE\`;
      }
      function interpolatedElsewhere(referencedAssetIds: string[]): void {
        query\`SELECT \${referencedAssetIds} FROM "MediaAsset" WHERE id = ANY('{constant}') ORDER BY id FOR UPDATE\`;
      }
      function noRowPredicate(referencedAssetIds: string[]): void {
        query\`SELECT id FROM "MediaAsset" WHERE status = \${referencedAssetIds} ORDER BY id FOR UPDATE\`;
      }
    `);
    const functions = new Map<string, ts.FunctionDeclaration>();
    for (const statement of fixture.source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
        functions.set(statement.name.text, statement);
      }
    }
    const proves = (name: string) => {
      const declaration = functions.get(name);
      if (declaration === undefined)
        throw new Error('Set-lock fixture invalid');
      return hasSortedConflictingMediaLocks(
        fixture.program,
        [declaration],
        resolve('/'),
      );
    };
    expect(proves('good')).toBe(true);
    expect(proves('interpolatedElsewhere')).toBe(false);
    expect(proves('noRowPredicate')).toBe(false);
  });

  it('requires projectId to reach the advisory-lock key through helpers', () => {
    const fixture = createAnalyzerFixture(`
      declare function query(sql: TemplateStringsArray, ...values: unknown[]): void;
      function good(projectId: string): void { lockGood(projectId); }
      function lockGood(projectId: string): void {
        query\`SELECT pg_advisory_xact_lock(\${projectId})\`;
      }
      function bad(projectId: string): void { lockBad(projectId); }
      function lockBad(_projectId: string): void {
        query\`SELECT pg_advisory_xact_lock('constant')\`;
      }
      function interpolatedElsewhere(projectId: string): void {
        lockInterpolatedElsewhere(projectId);
      }
      function lockInterpolatedElsewhere(projectId: string): void {
        query\`SELECT \${projectId}, pg_advisory_xact_lock('constant')\`;
      }
    `);
    const checker = fixture.program.getTypeChecker();
    const operation = (name: string) => {
      const declaration = fixture.source.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(statement) && statement.name?.text === name,
      );
      const parameter = declaration?.parameters[0]?.name;
      const call = declaration
        ?.getChildren()
        .flatMap(function flatten(node): ts.Node[] {
          return [node, ...node.getChildren().flatMap(flatten)];
        })
        .find(ts.isCallExpression);
      const value =
        parameter !== undefined && ts.isIdentifier(parameter)
          ? resolvedSymbol(checker, parameter)
          : undefined;
      if (call === undefined || value === undefined) {
        throw new Error('Project-lock fixture is invalid');
      }
      return argumentReachesMatchingNode(
        checker,
        call,
        value,
        resolve('/'),
        (node, current) => advisoryLockKeyUsesValue(checker, node, current),
      );
    };
    expect(operation('good')).toBe(true);
    expect(operation('bad')).toBe(false);
    expect(operation('interpolatedElsewhere')).toBe(false);
  });

  it('rejects a local projectId constant when the operation input is ignored', () => {
    const fixture = createAnalyzerFixture(`
      declare function query(sql: TemplateStringsArray, ...values: unknown[]): void;
      class Operation {
        good(input: { projectId: string }): void { this.lock(input.projectId); }
        bad(input: { projectId: string }): void {
          void input;
          const projectId = 'local-constant';
          this.lock(projectId);
        }
        private lock(projectId: string): void {
          query\`SELECT pg_advisory_xact_lock(\${projectId})\`;
        }
      }
    `);
    const operation = fixture.source.statements.find(ts.isClassDeclaration);
    const proves = (name: string): boolean => {
      const entry = operation?.members.find(
        (member): member is ts.MethodDeclaration =>
          ts.isMethodDeclaration(member) && member.name.getText() === name,
      );
      const call =
        entry === undefined
          ? undefined
          : executableCalls(fixture.program.getTypeChecker(), entry).find(
              (candidate) => candidate.expression.getText().endsWith('.lock'),
            );
      if (entry === undefined || call === undefined) {
        throw new Error('Operation project fixture is invalid');
      }
      const checker = fixture.program.getTypeChecker();
      return [...operationProjectValues(checker, entry, resolve('/'))].some(
        (value) =>
          reachableMatchingNodes(
            checker,
            call,
            value,
            resolve('/'),
            (node, current) => advisoryLockKeyUsesValue(checker, node, current),
          ).size > 0,
      );
    };
    expect(proves('good')).toBe(true);
    expect(proves('bad')).toBe(false);
  });

  it('rejects a lock or write call that receives a different transaction context', () => {
    const fixture = createAnalyzerFixture(`
      declare const transactionContextBrand: unique symbol;
      interface TransactionContext { readonly [transactionContextBrand]: true }
      function lock(context: TransactionContext, projectId: string): void {
        void context; void projectId;
      }
      function entry(expected: TransactionContext, different: TransactionContext): void {
        lock(different, 'project');
        lock(expected, 'project');
      }
    `);
    const checker = fixture.program.getTypeChecker();
    const entry = fixture.source.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === 'entry',
    );
    const expected =
      entry?.parameters[0] === undefined
        ? undefined
        : resolvedSymbol(checker, entry.parameters[0].name);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) calls.push(node);
      ts.forEachChild(node, visit);
    };
    if (entry !== undefined) visit(entry);
    if (expected === undefined || calls.length !== 2) {
      throw new Error('Transaction fixture is invalid');
    }
    expect(
      callAcceptsExpectedTransactionContext(
        checker,
        calls[0] as ts.CallExpression,
        expected,
        resolve(fixture.source.fileName),
      ),
    ).toBe(false);
    expect(
      callAcceptsExpectedTransactionContext(
        checker,
        calls[1] as ts.CallExpression,
        expected,
        resolve(fixture.source.fileName),
      ),
    ).toBe(true);
  });

  it('requires mutation to use the context supplied by the TransactionRunner callback', () => {
    const fixture = createAnalyzerFixture(`
      declare const transactionContextBrand: unique symbol;
      interface Client { projectRevision: { create(): void } }
      interface TransactionContext extends Client { readonly [transactionContextBrand]: true }
      declare const different: Client;
      class TransactionRunner {
        run(work: (context: TransactionContext) => Promise<void>): Promise<void> {
          throw new Error(String(work));
        }
      }
      class Coordinator {
        constructor(private readonly runner: TransactionRunner) {}
        execute(input: { command: (context: TransactionContext) => Promise<void> }): Promise<void> {
          return this.runner.run(async (context) => input.command(context));
        }
      }
      class Operation {
        constructor(private readonly coordinator: Coordinator) {}
        good(): Promise<void> {
          return this.coordinator.execute({ command: async (context) => writeGood(context) });
        }
        bad(): Promise<void> {
          return this.coordinator.execute({ command: async (context) => writeBad(context, different) });
        }
      }
      function writeGood(context: TransactionContext): void {
        context.projectRevision.create();
      }
      function writeBad(context: TransactionContext, client: Client): void {
        void context;
        client.projectRevision.create();
      }
    `);
    const checker = fixture.program.getTypeChecker();
    const operation = fixture.source.statements.find(
      (statement): statement is ts.ClassDeclaration =>
        ts.isClassDeclaration(statement) &&
        statement.name?.text === 'Operation',
    );
    const proves = (name: string): boolean => {
      const entry = operation?.members.find(
        (member): member is ts.MethodDeclaration =>
          ts.isMethodDeclaration(member) && member.name.getText() === name,
      );
      if (entry === undefined) throw new Error('Context fixture is invalid');
      const values = transactionCallbackValues(
        checker,
        entry,
        resolve(fixture.source.fileName),
        resolve('/'),
      );
      const call = operationExecutionTrace(fixture.program, entry).find(
        (candidate) =>
          /write(?:Good|Bad)/u.test(candidate.expression.getText()),
      );
      if (values.size === 0 || call === undefined) {
        throw new Error('Transaction callback fixture is invalid');
      }
      return [...values].some(
        (value) =>
          reachableMatchingNodes(
            checker,
            call,
            value,
            resolve('/'),
            (node, current) =>
              localMutationEvidence(checker, node, 'sites-write') &&
              transactionBearingNodeUsesValue(
                checker,
                node,
                current,
                resolve(fixture.source.fileName),
              ),
          ).size > 0,
      );
    };
    expect(proves('good')).toBe(true);
    expect(proves('bad')).toBe(false);
  });

  it('exports transaction-aware publish-validation and retained-reference ports with opaque context', () => {
    const mediaPublic = publicTransactionSurface(
      join(mediaApplicationRoot, 'public.ts'),
    );
    const sitesPublic = publicTransactionSurface(
      join(sitesApplicationRoot, 'public.ts'),
    );

    // Media already owns import attachment. Publish validation is the second
    // cross-owner transaction-aware operation; cleanup remains media-internal.
    expect(mediaPublic.transactionMethods).toBeGreaterThanOrEqual(2);
    expect(mediaPublic.symbols).toBeGreaterThanOrEqual(2);
    expect(sitesPublic.transactionMethods).toBeGreaterThanOrEqual(1);
    expect(sitesPublic.symbols).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['save', 'save-project-draft.ts'],
    ['publish', 'publish-project.ts'],
  ] as const)(
    '%s locks the project, invokes the media public port with the transaction context, then writes',
    (_operation, file) => {
      expect(
        orderedCrossPortFlow(program, {
          file: join(sitesApplicationRoot, file),
          owner: 'media',
          terminalKind: 'sites-write',
        }),
      ).toBe(true);
    },
  );

  it('deletion locks the project, invokes the sites public port with the transaction context, then mutates media', () => {
    expect(
      mediaFiles.some((file) =>
        orderedCrossPortFlow(program, {
          file,
          owner: 'sites',
          terminalKind: 'media-mutation',
        }),
      ),
    ).toBe(true);
  });

  it('keeps the real tree free of cross-module infrastructure and Prisma leaks', () => {
    expect(findArchitectureViolations()).toEqual([]);
  });

  it('rejects a cross-owner infrastructure shortcut while allowing opaque public ports', () => {
    const fixture = createArchitectureFixture({
      'shared/database/transaction-runner.ts': `
        declare const transactionContextBrand: unique symbol;
        export interface TransactionContext {
          readonly [transactionContextBrand]: true;
        }
      `,
      'shared/database/prisma.service.ts': `
        export class PrismaClientService {}
      `,
      'modules/media/application/public.ts': `
        import type { TransactionContext } from '../../../shared/database/transaction-runner';
        export const MEDIA_PORT = Symbol('MediaPort');
        export interface MediaPort {
          check(context: TransactionContext, assetIds: readonly string[]): Promise<void>;
        }
      `,
      'modules/sites/application/public.ts': `
        import type { TransactionContext } from '../../../shared/database/transaction-runner';
        export const SITES_PORT = Symbol('SitesPort');
        export interface SitesPort {
          check(context: TransactionContext, assetIds: readonly string[]): Promise<void>;
        }
      `,
      'modules/sites/application/good-consumer.ts': `
        import type { MediaPort } from '../../media/application/public';
        export type PublicMediaPort = MediaPort;
      `,
      'modules/media/application/bad-consumer.ts': `
        import { LeakySitesRepository } from '../../sites/infrastructure/leaky-sites.repository';
        export const repository = new LeakySitesRepository();
      `,
      'modules/media/application/bad-prisma-consumer.ts': `
        import { PrismaClientService } from '../../../shared/database/prisma.service';
        export const database = new PrismaClientService();
      `,
      'modules/sites/infrastructure/leaky-sites.repository.ts': `
        import type { PrismaClient } from '@prisma/client';
        export class LeakySitesRepository {
          declare readonly prisma: PrismaClient;
        }
      `,
    });

    try {
      const violations = findArchitectureViolations(
        fixture.sourceRoot,
        fixture.modulesRoot,
      );
      expect(violations).toContain(
        'modules/media/application/bad-consumer.ts crosses into modules/sites/infrastructure/leaky-sites.repository.ts; cross-module imports must target application/public.ts',
      );
      expect(
        violations.some(
          (violation) =>
            violation.startsWith(
              'modules/media/application/bad-prisma-consumer.ts',
            ) && violation.includes('PrismaService'),
        ),
      ).toBe(true);
      expect(
        violations.some((violation) =>
          violation.startsWith('modules/sites/application/good-consumer.ts'),
        ),
      ).toBe(false);
    } finally {
      removeArchitectureFixture(fixture);
    }
  });
});
