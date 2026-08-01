import path from 'node:path';
import ts from 'typescript';
import type { RestrictedOrigin } from '../types/architecture.types';

export function isPrismaImport(specifier: string): boolean {
  return (
    specifier === '@prisma/client' || specifier.startsWith('@prisma/client/')
  );
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
): RestrictedOrigin | undefined {
  const normalizedFileName = fileName.split(path.sep).join('/');

  if (normalizedFileName.includes('/node_modules/@prisma/client/')) {
    return 'prisma';
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
