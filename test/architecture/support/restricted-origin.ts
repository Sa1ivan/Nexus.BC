import path from 'node:path';
import ts from 'typescript';
import type { RestrictedOrigin } from '../types/architecture.types';
import { canonicalPath } from './module-paths';

export function isPrismaImport(specifier: string): boolean {
  return specifier.startsWith('@prisma/');
}

export function isProviderSdkImport(specifier: string): boolean {
  return (
    specifier.startsWith('@aws-sdk/') ||
    specifier === 'resend' ||
    specifier.startsWith('resend/') ||
    specifier.startsWith('@resend/')
  );
}

export function restrictedOriginsForSpecifier(
  specifier: string,
): ReadonlySet<RestrictedOrigin> {
  const origins = new Set<RestrictedOrigin>();

  if (isPrismaImport(specifier)) {
    origins.add('prisma');
  }
  if (specifier.startsWith('@aws-sdk/')) {
    origins.add('aws-sdk');
  }
  if (
    specifier === 'resend' ||
    specifier.startsWith('resend/') ||
    specifier.startsWith('@resend/')
  ) {
    origins.add('resend');
  }

  return origins;
}

export function addOrigins(
  target: Set<RestrictedOrigin>,
  origins: ReadonlySet<RestrictedOrigin>,
): void {
  for (const origin of origins) {
    target.add(origin);
  }
}

export function isPrismaServiceLikeName(name: string): boolean {
  return /^Prisma[A-Za-z0-9_$]*Service$/u.test(name);
}

export function sourceFileOrigin(
  fileName: string,
  sourceRoot?: string,
): RestrictedOrigin | undefined {
  const canonicalFileName = canonicalPath(fileName);
  const normalizedFileName = canonicalFileName.split(path.sep).join('/');

  if (normalizedFileName.includes('/node_modules/@prisma/')) {
    return 'prisma';
  }
  if (sourceRoot !== undefined) {
    const relativePath = path
      .relative(canonicalPath(sourceRoot), canonicalFileName)
      .split(path.sep)
      .join('/');
    if (relativePath.startsWith('generated/prisma/')) {
      return 'prisma';
    }
  }
  if (normalizedFileName.includes('/node_modules/@aws-sdk/')) {
    return 'aws-sdk';
  }
  if (normalizedFileName.includes('/node_modules/resend/')) {
    return 'resend';
  }
  if (normalizedFileName.includes('/node_modules/@resend/')) {
    return 'resend';
  }

  return undefined;
}

export function isGeneratedPrismaSourceFile(
  fileName: string | undefined,
  sourceRoot: string,
): boolean {
  return (
    fileName !== undefined &&
    sourceFileOrigin(fileName, sourceRoot) === 'prisma'
  );
}

export function enclosingModuleSpecifier(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node;

  while (current !== undefined && !ts.isSourceFile(current)) {
    if (
      (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) &&
      current.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(current.moduleSpecifier)
    ) {
      return current.moduleSpecifier.text;
    }
    if (
      ts.isImportEqualsDeclaration(current) &&
      ts.isExternalModuleReference(current.moduleReference) &&
      current.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(current.moduleReference.expression)
    ) {
      return current.moduleReference.expression.text;
    }

    current = current.parent;
  }

  return undefined;
}

export function referencedExportName(node: ts.Node): string | undefined {
  if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
    return (node.propertyName ?? node.name).text;
  }
  if (ts.isNamespaceImport(node) || ts.isNamespaceExport(node)) {
    return '*';
  }
  if (ts.isImportClause(node)) {
    return 'default';
  }
  if (ts.isImportEqualsDeclaration(node)) {
    return '*';
  }

  return undefined;
}

export function restrictedOriginLabel(origin: RestrictedOrigin): string {
  switch (origin) {
    case 'aws-sdk':
      return 'AWS SDK';
    case 'prisma':
      return 'Prisma-origin';
    case 'prisma-service':
      return 'PrismaService-like';
    case 'resend':
      return 'Resend';
  }
}

export function referencesPrismaServiceLikeSymbol(
  sourceFile: ts.SourceFile,
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isPrismaServiceLikeName(node.text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
