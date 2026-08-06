import ts from 'typescript';
import {
  createArchitectureFixture,
  removeArchitectureFixture,
} from './support/architecture-fixture';
import {
  listTypeScriptFiles,
  sourceRoot,
  toSourceRelativePath,
} from './support/module-paths';

interface ProcessEnvironmentRead {
  readonly file: string;
  readonly functionName: string | undefined;
}

interface ProcessBindings {
  readonly environment: ReadonlySet<string>;
  readonly process: ReadonlySet<string>;
}

function processBindings(sourceFile: ts.SourceFile): ProcessBindings {
  const environment = new Set<string>();
  const process = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      (statement.moduleSpecifier.text !== 'node:process' &&
        statement.moduleSpecifier.text !== 'process')
    ) {
      continue;
    }

    const importClause = statement.importClause;
    if (importClause?.name) {
      process.add(importClause.name.text);
    }
    if (
      importClause?.namedBindings &&
      ts.isNamespaceImport(importClause.namedBindings)
    ) {
      process.add(importClause.namedBindings.name.text);
    }
    if (
      importClause?.namedBindings &&
      ts.isNamedImports(importClause.namedBindings)
    ) {
      for (const element of importClause.namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (importedName === 'env') {
          environment.add(element.name.text);
        } else if (importedName === 'default') {
          process.add(element.name.text);
        }
      }
    }
  }

  return { environment, process };
}

function propertyName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteral(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function propertyTarget(node: ts.Node): ts.Expression | undefined {
  return ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
    ? node.expression
    : undefined;
}

function isProcessReference(
  node: ts.Expression,
  bindings: ProcessBindings,
): boolean {
  if (ts.isIdentifier(node)) {
    return node.text === 'process' || bindings.process.has(node.text);
  }

  const target = propertyTarget(node);
  return (
    propertyName(node) === 'process' &&
    target !== undefined &&
    ts.isIdentifier(target) &&
    (target.text === 'globalThis' || target.text === 'global')
  );
}

function isProcessEnvironment(
  node: ts.Node,
  bindings: ProcessBindings,
): boolean {
  if (
    ts.isIdentifier(node) &&
    bindings.environment.has(node.text) &&
    !ts.isImportSpecifier(node.parent)
  ) {
    return true;
  }

  if (
    ts.isBindingElement(node) &&
    (node.propertyName?.getText(node.getSourceFile()) ??
      node.name.getText()) === 'env' &&
    ts.isObjectBindingPattern(node.parent) &&
    ts.isVariableDeclaration(node.parent.parent) &&
    node.parent.parent.initializer !== undefined &&
    isProcessReference(node.parent.parent.initializer, bindings)
  ) {
    return true;
  }

  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'Reflect' &&
    node.expression.name.text === 'get' &&
    node.arguments[0] !== undefined &&
    isProcessReference(node.arguments[0], bindings) &&
    node.arguments[1] !== undefined &&
    ts.isStringLiteralLike(node.arguments[1]) &&
    node.arguments[1].text === 'env'
  ) {
    return true;
  }

  const target = propertyTarget(node);
  return (
    propertyName(node) === 'env' &&
    target !== undefined &&
    isProcessReference(target, bindings)
  );
}

function enclosingFunctionName(node: ts.Node): string | undefined {
  let current = node.parent;

  while (current) {
    if (ts.isFunctionDeclaration(current)) {
      return current.name?.text;
    }
    current = current.parent;
  }

  return undefined;
}

function findProcessEnvironmentReads(
  projectSourceRoot = sourceRoot,
): ProcessEnvironmentRead[] {
  return listTypeScriptFiles(projectSourceRoot).flatMap((filePath) => {
    const sourceText = ts.sys.readFile(filePath);
    if (sourceText === undefined) {
      throw new Error(`Unable to read ${filePath}`);
    }

    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
    );
    const bindings = processBindings(sourceFile);
    const reads: ProcessEnvironmentRead[] = [];

    function visit(node: ts.Node): void {
      if (isProcessEnvironment(node, bindings)) {
        reads.push({
          file: toSourceRelativePath(filePath, projectSourceRoot),
          functionName: enclosingFunctionName(node),
        });
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return reads;
  });
}

describe('runtime configuration boundary', () => {
  it('allows process.env reads only inside the validation factory', () => {
    expect(findProcessEnvironmentReads()).toEqual([
      {
        file: 'shared/config/app-config.schema.ts',
        functionName: 'loadAppConfig',
      },
    ]);
  });

  it('detects alternate Node.js process environment access forms', () => {
    const fixture = createArchitectureFixture({
      'bracket.ts': `
        export function readBracket(): void {
          void process['env'];
        }
      `,
      'global-this.ts': `
        export function readGlobalThis(): void {
          void globalThis.process.env;
        }
      `,
      'named-import.ts': `
        import { env as runtimeEnvironment } from 'node:process';

        export function readNamedImport(): void {
          void runtimeEnvironment;
        }
      `,
      'default-import.ts': `
        import runtimeProcess from 'node:process';

        export function readDefaultImport(): void {
          void runtimeProcess.env;
        }
      `,
      'destructured.ts': `
        export function readDestructured(): void {
          const { env: runtimeEnvironment } = process;
          void runtimeEnvironment;
        }
      `,
      'reflective.ts': `
        export function readReflective(): void {
          void Reflect.get(process, 'env');
        }
      `,
    });

    try {
      expect(findProcessEnvironmentReads(fixture.sourceRoot)).toEqual([
        { file: 'bracket.ts', functionName: 'readBracket' },
        { file: 'default-import.ts', functionName: 'readDefaultImport' },
        { file: 'destructured.ts', functionName: 'readDestructured' },
        { file: 'global-this.ts', functionName: 'readGlobalThis' },
        { file: 'named-import.ts', functionName: 'readNamedImport' },
        { file: 'reflective.ts', functionName: 'readReflective' },
      ]);
    } finally {
      removeArchitectureFixture(fixture);
    }
  });
});
