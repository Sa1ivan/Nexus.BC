import { existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  createArchitectureProjectFile,
  createArchitectureSymlink,
  createArchitectureFixture,
  removeArchitectureFixture,
} from './support/architecture-fixture';
import { findArchitectureViolations } from './support/architecture-scanner';
import {
  modulesRoot,
  readCompilerOptions,
  requiredModules,
  sourceRoot,
} from './support/module-paths';
import {
  createOriginResolver,
  originsForExport,
} from './support/restricted-origin-resolver';
import { p101ExpectedViolations } from './support/p101-expected-violations';
import { p101FixtureFiles } from './support/p101-fixture-files';
import { p101RegressionExpectedViolations } from './support/p101-regression-expected-violations';
import { p101RegressionFixtureFiles } from './support/p101-regression-fixture-files';

describe('module architecture', () => {
  it('defines every required module composition root', () => {
    const missingCompositionRoots = requiredModules.filter((moduleName) => {
      const modulePath = path.join(
        modulesRoot,
        moduleName,
        `${moduleName}.module.ts`,
      );
      return !existsSync(modulePath);
    });

    expect(missingCompositionRoots).toEqual([]);
  });

  it('does not traverse unrestricted external type graphs', () => {
    const compilerOptions = readCompilerOptions();
    const requestContractPath = path.join(
      sourceRoot,
      'shared/http/request-contract.ts',
    );
    const program = ts.createProgram([requestContractPath], compilerOptions);
    const sourceFile = program.getSourceFile(requestContractPath);
    if (sourceFile === undefined) {
      throw new Error('Unable to parse shared/http/request-contract.ts');
    }
    const resolver = createOriginResolver(program, compilerOptions, sourceRoot);

    expect([...originsForExport(sourceFile, 'readCookie', resolver)]).toEqual(
      [],
    );
  });

  it('detects restricted origins hidden behind an external type facade', () => {
    const fixture = createArchitectureFixture({
      'shared/external-wrapper.ts': `
        import type { Facade } from 'prisma-facade';
        export type HiddenFacade = Facade;
      `,
      'shared/safe-external-wrapper.ts': `
        import type { SafeFacade } from 'mixed-facade';
        export type SafeExternalFacade = SafeFacade;
      `,
      'shared/cyclic-external-wrapper.ts': `
        import type { CyclicA } from 'cyclic-facade-a';
        import type { CyclicB } from 'cyclic-facade-b';
        export type HiddenCyclicA = CyclicA;
        export type HiddenCyclicB = CyclicB;
      `,
      'modules/auth/application/facade-consumer.ts': `
        import type { HiddenFacade } from '../../../shared/external-wrapper';
        import type { SafeExternalFacade } from '../../../shared/safe-external-wrapper';
        import type { HiddenCyclicA, HiddenCyclicB } from '../../../shared/cyclic-external-wrapper';
        export interface FacadeConsumer {
          readonly client: HiddenFacade;
          readonly safe: SafeExternalFacade;
          readonly cyclicA: HiddenCyclicA;
          readonly cyclicB: HiddenCyclicB;
        }
      `,
    });
    createArchitectureProjectFile(
      fixture,
      'node_modules/prisma-facade/package.json',
      JSON.stringify({ name: 'prisma-facade', types: 'index.d.ts' }),
    );
    createArchitectureProjectFile(
      fixture,
      'node_modules/prisma-facade/index.d.ts',
      `
        import type { NestedFacade } from 'nested-facade';
        export interface Facade extends NestedFacade {}
      `,
    );
    createArchitectureProjectFile(
      fixture,
      'node_modules/cyclic-facade-a/package.json',
      JSON.stringify({ name: 'cyclic-facade-a', types: 'index.d.ts' }),
    );
    createArchitectureProjectFile(
      fixture,
      'node_modules/cyclic-facade-a/index.d.ts',
      `
        import type { CyclicB } from 'cyclic-facade-b';
        import type { PrismaClient } from '@prisma/client';
        export interface CyclicA extends CyclicB, PrismaClient {}
      `,
    );
    createArchitectureProjectFile(
      fixture,
      'node_modules/cyclic-facade-b/package.json',
      JSON.stringify({ name: 'cyclic-facade-b', types: 'index.d.ts' }),
    );
    createArchitectureProjectFile(
      fixture,
      'node_modules/cyclic-facade-b/index.d.ts',
      `
        import type { CyclicA } from 'cyclic-facade-a';
        export interface CyclicB extends CyclicA {}
      `,
    );
    createArchitectureProjectFile(
      fixture,
      'node_modules/nested-facade/package.json',
      JSON.stringify({ name: 'nested-facade', types: 'index.d.ts' }),
    );
    createArchitectureProjectFile(
      fixture,
      'node_modules/nested-facade/index.d.ts',
      `
        import type { PrismaClient } from '@prisma/client';
        export interface NestedFacade extends PrismaClient {}
      `,
    );
    createArchitectureProjectFile(
      fixture,
      'node_modules/mixed-facade/package.json',
      JSON.stringify({ name: 'mixed-facade', types: 'index.d.ts' }),
    );
    createArchitectureProjectFile(
      fixture,
      'node_modules/mixed-facade/index.d.ts',
      `
        import type { PrismaClient } from '@prisma/client';
        export interface UnsafeFacade extends PrismaClient {}
        export interface SafeFacade { readonly value: string; }
      `,
    );

    try {
      const violations = findArchitectureViolations(
        fixture.sourceRoot,
        fixture.modulesRoot,
      );
      expect(violations).toContain(
        'modules/auth/application/facade-consumer.ts may not consume Prisma-origin symbol HiddenFacade outside approved infrastructure adapters',
      );
      expect(violations).not.toContain(
        'modules/auth/application/facade-consumer.ts may not consume Prisma-origin symbol SafeExternalFacade outside approved infrastructure adapters',
      );
      expect(violations).toEqual(
        expect.arrayContaining([
          'modules/auth/application/facade-consumer.ts may not consume Prisma-origin symbol HiddenCyclicA outside approved infrastructure adapters',
          'modules/auth/application/facade-consumer.ts may not consume Prisma-origin symbol HiddenCyclicB outside approved infrastructure adapters',
        ]),
      );
    } finally {
      removeArchitectureFixture(fixture);
    }
  });

  it('does not project a use case dependency onto its API consumer', () => {
    const fixture = createArchitectureFixture({
      'modules/notifications/application/public.ts': `
        export interface NotificationPort {
          enqueue(): Promise<void>;
        }
      `,
      'modules/auth/application/register-user.ts': `
        import type { NotificationPort } from '../../notifications/application/public';

        export class RegisterUser {
          constructor(private readonly notifications: NotificationPort) {}

          execute(): Promise<void> {
            return this.notifications.enqueue();
          }
        }
      `,
      'modules/auth/api/auth.controller.ts': `
        import { RegisterUser } from '../application/register-user';

        export class AuthController {
          constructor(private readonly registerUser: RegisterUser) {}
        }
      `,
    });

    try {
      expect(
        findArchitectureViolations(fixture.sourceRoot, fixture.modulesRoot),
      ).toEqual([]);
    } finally {
      removeArchitectureFixture(fixture);
    }
  });

  it('enforces module, persistence, and controller boundaries', () => {
    expect(findArchitectureViolations()).toEqual([]);
  });

  it('blocks every P1-01 architecture bypass while retaining safe controls', () => {
    const fixture = createArchitectureFixture(p101FixtureFiles);

    try {
      const violations = findArchitectureViolations(
        fixture.sourceRoot,
        fixture.modulesRoot,
      );
      expect([...violations].sort()).toEqual(p101ExpectedViolations);

      for (const safePath of [
        'shared/audit/prisma-audit-writer.ts',
        'shared/idempotency/prisma-idempotency.adapter.ts',
        'modules/auth/application/good-contracts.ts',
        'modules/media/infrastructure/aws-owner.ts',
        'modules/notifications/infrastructure/resend-owner.ts',
      ]) {
        expect(
          violations.some((violation) => violation.startsWith(safePath)),
        ).toBe(false);
      }
      expect(
        violations.some(
          (violation) =>
            violation.includes('SAFE_SHARED') ||
            violation.includes('SafeShared'),
        ),
      ).toBe(false);
      expect(
        violations.some(
          (violation) =>
            violation.startsWith('modules/auth/api/safe-decorator-entry.ts') &&
            violation.includes('controller may not'),
        ),
      ).toBe(false);
      expect(
        violations.some((violation) =>
          violation.startsWith('modules/auth/domain/shadowed-require.ts'),
        ),
      ).toBe(false);
    } finally {
      removeArchitectureFixture(fixture);
    }
  });

  it('enforces adversarial P1-01 terminal and controller regressions', () => {
    const fixture = createArchitectureFixture(p101RegressionFixtureFiles);
    createArchitectureSymlink(
      fixture,
      'shared/private-link.ts',
      '../modules/sites/domain/symlink-private.ts',
    );

    try {
      const violations = findArchitectureViolations(
        fixture.sourceRoot,
        fixture.modulesRoot,
      );
      expect([...violations].sort()).toEqual(p101RegressionExpectedViolations);

      for (const safePath of [
        'modules/auth/application/legal-public-consumer.ts',
        'modules/auth/api/handler-entry.ts route handler HandlerEntry.safe',
        'modules/auth/api/handler-entry.ts route handler HandlerEntry.safeAlias',
        'modules/auth/api/handler-entry.ts route handler HandlerEntry.safeDestructured',
        'modules/auth/api/handler-entry.ts route handler HandlerEntry.safeDirectImport',
        'modules/auth/api/handler-entry.ts route handler HandlerEntry.safePropertyAlias',
        'modules/auth/api/handler-entry.ts route handler HandlerEntry.safeReexportAlias',
        'modules/auth/api/handler-entry.ts route handler HandlerEntry.safeReflectApply',
        'modules/auth/api/handler-entry.ts route handler HandlerEntry.safeReflectConstruct',
        'modules/auth/api/handler-entry.ts route handler HandlerEntry.helper',
        'modules/auth/api/route-wrapper-entry.ts route handler RouteWrapperEntry.localCompositeControl',
        'modules/auth/api/route-wrapper-entry.ts route handler RouteWrapperEntry.helper',
        'shared/audit/prisma-audit-writer.ts',
        'shared/audit/infrastructure/r2-recovery-audit-storage.ts',
        'shared/database/recursive-b.ts',
      ]) {
        expect(
          violations.some((violation) => violation.startsWith(safePath)),
        ).toBe(false);
      }
    } finally {
      removeArchitectureFixture(fixture);
    }
  });

  it('skips generated Prisma scan roots while still rejecting their consumers', () => {
    const fixture = createArchitectureFixture({
      'generated/prisma/client.ts': `
        import type { PrismaClient as RuntimePrismaClient } from '@prisma/client';
        import type { S3Client } from '@aws-sdk/client-s3';
        export type PrismaClient = RuntimePrismaClient;
        export type StorageClient = S3Client;
      `,
      'modules/auth/application/generated-consumer.ts': `
        import type {
          PrismaClient,
          StorageClient,
        } from '../../../generated/prisma/client';
        export type GeneratedClient = PrismaClient;
        export type GeneratedStorageClient = StorageClient;
      `,
    });

    try {
      expect(
        findArchitectureViolations(fixture.sourceRoot, fixture.modulesRoot),
      ).toEqual([
        'modules/auth/application/generated-consumer.ts may not consume Prisma-origin symbol PrismaClient outside approved infrastructure adapters',
        'modules/auth/application/generated-consumer.ts may not consume AWS SDK symbol PrismaClient outside modules/media/infrastructure',
        'modules/auth/application/generated-consumer.ts may not consume Prisma-origin symbol StorageClient outside approved infrastructure adapters',
        'modules/auth/application/generated-consumer.ts may not consume AWS SDK symbol StorageClient outside modules/media/infrastructure',
        'modules/auth/application/generated-consumer.ts may not import ../../../generated/prisma/client; Prisma access belongs in approved infrastructure adapters',
      ]);
    } finally {
      removeArchitectureFixture(fixture);
    }
  });

  it('rejects direct application access to the Prisma service token', () => {
    const fixture = createArchitectureFixture({
      'shared/database/prisma.service.ts': `
        export const PrismaClientService = Symbol('PrismaClientService');
      `,
      'modules/auth/application/prisma-token-consumer.ts': `
        import { PrismaClientService } from '../../../shared/database/prisma.service';
        export const leakedDatabaseToken = PrismaClientService;
      `,
    });

    try {
      expect(
        findArchitectureViolations(fixture.sourceRoot, fixture.modulesRoot),
      ).toEqual([
        'modules/auth/application/prisma-token-consumer.ts may not consume PrismaService-like symbol PrismaClientService outside approved infrastructure adapters',
        'modules/auth/application/prisma-token-consumer.ts may not reference PrismaService outside approved infrastructure adapters',
      ]);
    } finally {
      removeArchitectureFixture(fixture);
    }
  });

  it('allows only the opaque shared transaction context in application public ports', () => {
    const fixture = createArchitectureFixture({
      'shared/database/transaction-runner.ts': `
        declare const transactionContextBrand: unique symbol;

        export interface TransactionContext {
          readonly [transactionContextBrand]: true;
        }
        export interface DatabaseClient {
          readonly query: unknown;
        }
      `,
      'modules/auth/application/public.ts': `
        import type {
          DatabaseClient,
          TransactionContext,
        } from '../../../shared/database/transaction-runner';

        export interface TransactionAwarePort {
          run(context: TransactionContext): Promise<void>;
        }

        export interface LeakyDatabasePort {
          run(client: DatabaseClient): Promise<void>;
        }
      `,
    });

    try {
      expect(
        findArchitectureViolations(fixture.sourceRoot, fixture.modulesRoot),
      ).toEqual([
        'modules/auth/application/public.ts application/public.ts may not export LeakyDatabasePort; only same-module application type/interface contracts and Symbol DI tokens are public',
      ]);
    } finally {
      removeArchitectureFixture(fixture);
    }
  });

  it('rejects a leaky shared transaction context despite its exact name and path', () => {
    const fixture = createArchitectureFixture({
      'shared/database/transaction-runner.ts': `
        export interface TransactionContext {
          readonly client: unknown;
        }
      `,
      'modules/auth/application/public.ts': `
        import type { TransactionContext } from '../../../shared/database/transaction-runner';

        export interface LeakyTransactionPort {
          run(context: TransactionContext): Promise<void>;
        }
      `,
    });

    try {
      expect(
        findArchitectureViolations(fixture.sourceRoot, fixture.modulesRoot),
      ).toEqual([
        'modules/auth/application/public.ts application/public.ts may not export LeakyTransactionPort; only same-module application type/interface contracts and Symbol DI tokens are public',
      ]);
    } finally {
      removeArchitectureFixture(fixture);
    }
  });
});
