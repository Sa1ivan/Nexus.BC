import type ts from 'typescript';

export type ModuleLayer = 'api' | 'application' | 'domain' | 'infrastructure';

export type RestrictedOrigin =
  'aws-sdk' | 'prisma' | 'prisma-service' | 'resend';

export type ImportLikeOperation = 'import' | 'require';

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
  readonly exportCache: Map<string, ReadonlySet<RestrictedOrigin>>;
  readonly exportsInProgress: Set<string>;
  readonly program: ts.Program;
  readonly sourceRoot: string;
  readonly symbolCache: Map<ts.Symbol, ReadonlySet<RestrictedOrigin>>;
  readonly symbolsInProgress: Set<ts.Symbol>;
}

export interface RestrictedBinding {
  readonly name: string;
  readonly origins: ReadonlySet<RestrictedOrigin>;
}
