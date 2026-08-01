import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  createArchitectureSymlink,
  createArchitectureFixture,
  removeArchitectureFixture,
} from './support/architecture-fixture';
import { findArchitectureViolations } from './support/architecture-scanner';
import { modulesRoot, requiredModules } from './support/module-paths';
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
});
