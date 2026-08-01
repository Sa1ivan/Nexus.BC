import type ts from 'typescript';

export type ModuleLayer = 'api' | 'application' | 'domain' | 'infrastructure';

export type RestrictedOrigin =
  'aws-sdk' | 'prisma' | 'prisma-service' | 'resend';

export type ImportLikeOperation = 'import' | 'require';

export interface ImportLikeDependency {
  readonly exportName: string;
  readonly specifier: string;
}

export interface ModuleLocation {
  readonly moduleName: string;
  readonly layer: ModuleLayer | undefined;
  readonly isCompositionRoot: boolean;
}

export interface ArchitectureFixture {
  readonly projectRoot: string;
  readonly sourceRoot: string;
  readonly modulesRoot: string;
}

export interface OriginResolver {
  readonly checker: ts.TypeChecker;
  readonly compilerOptions: ts.CompilerOptions;
  readonly program: ts.Program;
  readonly sourceRoot: string;
}

export interface RestrictedBinding {
  readonly name: string;
  readonly origins: ReadonlySet<RestrictedOrigin>;
}
