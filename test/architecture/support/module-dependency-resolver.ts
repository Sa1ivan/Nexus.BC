import path from 'node:path';
import ts from 'typescript';
import type {
  ImportLikeDependency,
  OriginResolver,
} from '../types/architecture.types';
import { canonicalPath, resolveImport } from './module-paths';

interface ResolutionContext {
  readonly seenExports: Set<string>;
  readonly seenSymbols: Set<ts.Symbol>;
}

function addFiles(target: Set<string>, files: ReadonlySet<string>): void {
  for (const file of files) {
    target.add(file);
  }
}

function isWithinSourceRoot(fileName: string, sourceRoot: string): boolean {
  const relativePath = path.relative(
    canonicalPath(sourceRoot),
    canonicalPath(fileName),
  );
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function programSourceFile(
  fileName: string,
  resolver: OriginResolver,
): ts.SourceFile | undefined {
  const canonicalFileName = canonicalPath(fileName);
  return (
    resolver.program.getSourceFile(canonicalFileName) ??
    resolver.program
      .getSourceFiles()
      .find(
        (sourceFile) =>
          canonicalPath(sourceFile.fileName) === canonicalFileName,
      )
  );
}

function targetSourceFile(
  specifier: string,
  containingFile: string,
  resolver: OriginResolver,
): ts.SourceFile | undefined {
  const resolved = resolveImport(
    specifier,
    containingFile,
    resolver.compilerOptions,
  );
  if (
    resolved === undefined ||
    !isWithinSourceRoot(resolved, resolver.sourceRoot)
  ) {
    return undefined;
  }
  return programSourceFile(resolved, resolver);
}

function importTypeDependency(
  node: ts.ImportTypeNode,
): ImportLikeDependency | undefined {
  if (
    !ts.isLiteralTypeNode(node.argument) ||
    !ts.isStringLiteralLike(node.argument.literal)
  ) {
    return undefined;
  }
  return {
    exportName: node.qualifier?.getText(node.getSourceFile()) ?? '*',
    specifier: node.argument.literal.text,
  };
}

function terminalFilesForNode(
  node: ts.Node,
  resolver: OriginResolver,
  context: ResolutionContext,
): ReadonlySet<string> {
  const terminalFiles = new Set<string>();
  const visit = (current: ts.Node): void => {
    if (ts.isImportTypeNode(current)) {
      const dependency = importTypeDependency(current);
      if (dependency !== undefined) {
        const target = targetSourceFile(
          dependency.specifier,
          current.getSourceFile().fileName,
          resolver,
        );
        if (target !== undefined) {
          addFiles(
            terminalFiles,
            terminalFilesForExport(
              target,
              dependency.exportName,
              resolver,
              context,
            ),
          );
        }
      }
      return;
    }
    if (ts.isIdentifier(current)) {
      const symbol = resolver.checker.getSymbolAtLocation(current);
      if (symbol !== undefined) {
        addFiles(
          terminalFiles,
          terminalFilesForSymbol(symbol, resolver, context),
        );
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return terminalFiles;
}

function terminalFilesForSymbol(
  symbol: ts.Symbol,
  resolver: OriginResolver,
  context: ResolutionContext,
): ReadonlySet<string> {
  if (context.seenSymbols.has(symbol)) {
    return new Set();
  }
  context.seenSymbols.add(symbol);
  const terminalFiles = new Set<string>();

  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const aliased = resolver.checker.getAliasedSymbol(symbol);
    if (aliased !== symbol) {
      addFiles(
        terminalFiles,
        terminalFilesForSymbol(aliased, resolver, context),
      );
    }
  }

  if (terminalFiles.size === 0) {
    for (const declaration of symbol.getDeclarations() ?? []) {
      const sourceFile = declaration.getSourceFile();
      if (!isWithinSourceRoot(sourceFile.fileName, resolver.sourceRoot)) {
        continue;
      }
      if (ts.isSourceFile(declaration)) {
        addFiles(
          terminalFiles,
          terminalFilesForExport(declaration, '*', resolver, context),
        );
        continue;
      }
      const referencedFiles = terminalFilesForNode(
        declaration,
        resolver,
        context,
      );
      if (referencedFiles.size === 0) {
        terminalFiles.add(canonicalPath(sourceFile.fileName));
      } else {
        addFiles(terminalFiles, referencedFiles);
      }
    }
  }

  context.seenSymbols.delete(symbol);
  return terminalFiles;
}

function nestedModuleSourceFiles(
  symbol: ts.Symbol,
  resolver: OriginResolver,
): readonly ts.SourceFile[] {
  const target =
    (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? resolver.checker.getAliasedSymbol(symbol)
      : symbol;
  return (target.getDeclarations() ?? []).flatMap((declaration) =>
    ts.isSourceFile(declaration) ? [declaration] : [],
  );
}

function terminalFilesForExport(
  sourceFile: ts.SourceFile,
  exportName: string,
  resolver: OriginResolver,
  context: ResolutionContext,
): ReadonlySet<string> {
  const canonicalFileName = canonicalPath(sourceFile.fileName);
  const cacheKey = `${canonicalFileName}::${exportName}`;
  if (context.seenExports.has(cacheKey)) {
    return new Set();
  }
  context.seenExports.add(cacheKey);
  const terminalFiles = new Set<string>();
  const [firstName, ...nestedNames] = exportName.split('.');
  const moduleSymbol = resolver.checker.getSymbolAtLocation(sourceFile);
  const exports =
    moduleSymbol === undefined
      ? []
      : resolver.checker.getExportsOfModule(moduleSymbol);
  const selected =
    firstName === '*'
      ? exports
      : exports.filter((symbol) => symbol.getName() === firstName);

  for (const symbol of selected) {
    if (nestedNames.length === 0) {
      addFiles(
        terminalFiles,
        terminalFilesForSymbol(symbol, resolver, context),
      );
      continue;
    }
    for (const nestedSource of nestedModuleSourceFiles(symbol, resolver)) {
      addFiles(
        terminalFiles,
        terminalFilesForExport(
          nestedSource,
          nestedNames.join('.'),
          resolver,
          context,
        ),
      );
    }
  }

  if (
    selected.length === 0 &&
    (exportName === '*' || exportName === 'default')
  ) {
    for (const statement of sourceFile.statements) {
      if (ts.isExportAssignment(statement)) {
        addFiles(
          terminalFiles,
          terminalFilesForNode(statement.expression, resolver, context),
        );
      }
    }
  }
  context.seenExports.delete(cacheKey);
  return terminalFiles;
}

export function resolveTerminalExportFiles(
  sourceFile: ts.SourceFile,
  exportName: string,
  resolver: OriginResolver,
): ReadonlySet<string> {
  return terminalFilesForExport(sourceFile, exportName, resolver, {
    seenExports: new Set(),
    seenSymbols: new Set(),
  });
}

export function resolveTerminalDependencyFiles(
  dependency: ImportLikeDependency,
  containingFile: string,
  resolver: OriginResolver,
): ReadonlySet<string> {
  const target = targetSourceFile(
    dependency.specifier,
    containingFile,
    resolver,
  );
  if (target === undefined) {
    return new Set();
  }
  const terminalFiles = resolveTerminalExportFiles(
    target,
    dependency.exportName,
    resolver,
  );
  return terminalFiles.size > 0
    ? terminalFiles
    : new Set([canonicalPath(target.fileName)]);
}
