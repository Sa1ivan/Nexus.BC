import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  createArchitectureFixture,
  removeArchitectureFixture,
} from './support/architecture-fixture';
import { findArchitectureViolations } from './support/architecture-scanner';
import { modulesRoot, requiredModules } from './support/module-paths';

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

  it('blocks restricted and module-boundary bypasses through every import-like form', () => {
    const fixture = createArchitectureFixture({
      'shared/database/prisma.barrel.ts': `
        export { PrismaClient as HiddenClient } from '@prisma/client';
        export * as PrismaNamespace from '@prisma/client';
        export class PrismaTenantService {}
      `,
      'shared/providers/sdk.barrel.ts': `
        export { S3Client as HiddenStorage } from '@aws-sdk/client-s3';
        export { Resend as HiddenMailer } from 'resend';
        export { Resend as default } from 'resend';
      `,
      'shared/restricted.barrel.ts': `
        export {
          HiddenClient as DataClient,
          PrismaNamespace as DataNamespace,
          PrismaTenantService as DataService,
        } from './database/prisma.barrel';
        export {
          HiddenStorage as StorageClient,
          HiddenMailer as MailClient,
        } from './providers/sdk.barrel';
        export { default } from './providers/sdk.barrel';
        export const SAFE_VALUE = 1;
      `,
      'shared/safe.barrel.ts': `
        export const SAFE_RUNTIME_VALUE = 1;
      `,
      'modules/auth/api/barrel.controller.ts': `
        import {
          DataClient as Client,
          StorageClient as Storage,
          MailClient as Mailer,
        } from '../../../shared/restricted.barrel';
        import * as Restricted from '../../../shared/restricted.barrel';
        void Client;
        void Storage;
        void Mailer;
        void Restricted;
      `,
      'modules/auth/api/direct.controller.ts': `
        import { PrismaClient as Client } from '@prisma/client';
        import { S3Client as Storage } from '@aws-sdk/client-s3';
        void Client;
        void Storage;
      `,
      'modules/auth/api/entrypoint.ts': `
        import { Controller as ApiController } from '@nestjs/common';
        import {
          DataClient as Client,
          StorageClient as Storage,
          MailClient as Mailer,
        } from '../../../shared/restricted.barrel';

        @ApiController()
        export class ApiEntryPoint {}

        void Client;
        void Storage;
        void Mailer;
      `,
      'modules/auth/api/reexports.controller.ts': `
        export {
          DataClient as Client,
          StorageClient as Storage,
          MailClient as Mailer,
          default as DefaultMailer,
        } from '../../../shared/restricted.barrel';
        export * as RestrictedNamespace from '../../../shared/restricted.barrel';
      `,
      'modules/auth/api/runtime.controller.ts': `
        const providerDependency = '@aws-sdk/client-s3';
        const prismaDependency = '@prisma/client';
        void import('../../../shared/restricted.barrel');
        void require('../../../shared/restricted.barrel');
        void import('../../../shared/safe.barrel');
        void require('../../../shared/safe.barrel');
        void import(providerDependency);
        void require(prismaDependency);
      `,
      'modules/auth/api/safe.controller.ts': `
        import { SAFE_VALUE } from '../../../shared/restricted.barrel';
        void SAFE_VALUE;
      `,
      'modules/auth/application/barrel-consumer.ts': `
        import { DataService as Access } from '../../../shared/restricted.barrel';
        void Access;
      `,
      'modules/auth/application/dynamic.ts': `
        export const dynamicValue = true;
      `,
      'modules/auth/application/required.ts': `
        export const requiredValue = true;
      `,
      'modules/auth/domain/runtime.ts': `
        const applicationDependency = '../application/dynamic';
        const moduleDependency = '../../sites/domain/dynamic-private';
        void require('../application/required');
        void import('../application/dynamic');
        void require('../../sites/domain/required-private');
        void import('../../sites/domain/dynamic-private');
        void import(applicationDependency);
        void require(moduleDependency);
      `,
      'modules/auth/domain/shadowed-require.ts': `
        export {};
        const require = (specifier: string): string => specifier;
        const runtimeDependency = '../../sites/domain/dynamic-private';
        void require(runtimeDependency);
      `,
      'modules/sites/domain/dynamic-private.ts': `
        export const dynamicPrivateValue = true;
      `,
      'modules/sites/domain/required-private.ts': `
        export const requiredPrivateValue = true;
      `,
    });

    try {
      const violations = findArchitectureViolations(
        fixture.sourceRoot,
        fixture.modulesRoot,
      );
      const expectedViolations = [
        'modules/auth/api/barrel.controller.ts controller may not consume Prisma-origin symbol Client',
        'modules/auth/api/barrel.controller.ts controller may not consume AWS SDK symbol Storage',
        'modules/auth/api/barrel.controller.ts controller may not consume Resend symbol Mailer',
        'modules/auth/api/barrel.controller.ts controller may not consume Prisma-origin symbol Restricted',
        'modules/auth/application/barrel-consumer.ts may not consume PrismaService-like symbol Access outside approved infrastructure adapters',
        'modules/auth/api/direct.controller.ts may not import @prisma/client; Prisma access belongs in approved infrastructure adapters',
        'modules/auth/api/direct.controller.ts controller may not import provider SDK @aws-sdk/client-s3',
        'modules/auth/api/entrypoint.ts controller may not consume Prisma-origin symbol Client',
        'modules/auth/api/entrypoint.ts controller may not consume AWS SDK symbol Storage',
        'modules/auth/api/entrypoint.ts controller may not consume Resend symbol Mailer',
        'modules/auth/api/reexports.controller.ts controller may not consume Prisma-origin symbol Client',
        'modules/auth/api/reexports.controller.ts controller may not consume AWS SDK symbol Storage',
        'modules/auth/api/reexports.controller.ts controller may not consume Resend symbol Mailer',
        'modules/auth/api/reexports.controller.ts controller may not consume Resend symbol DefaultMailer',
        'modules/auth/api/reexports.controller.ts controller may not consume Prisma-origin symbol RestrictedNamespace',
        'modules/auth/api/reexports.controller.ts controller may not consume AWS SDK symbol RestrictedNamespace',
        'modules/auth/api/reexports.controller.ts controller may not consume Resend symbol RestrictedNamespace',
        'modules/auth/api/runtime.controller.ts controller may not consume Prisma-origin symbol import("../../../shared/restricted.barrel")',
        'modules/auth/api/runtime.controller.ts controller may not consume AWS SDK symbol import("../../../shared/restricted.barrel")',
        'modules/auth/api/runtime.controller.ts controller may not consume Prisma-origin symbol require("../../../shared/restricted.barrel")',
        'modules/auth/api/runtime.controller.ts controller may not consume Resend symbol require("../../../shared/restricted.barrel")',
        'modules/auth/domain/runtime.ts may not depend on modules/auth/application/required.ts',
        'modules/auth/domain/runtime.ts may not depend on modules/auth/application/dynamic.ts',
        'modules/auth/domain/runtime.ts crosses into modules/sites/domain/required-private.ts; cross-module imports must target application/public.ts',
        'modules/auth/domain/runtime.ts crosses into modules/sites/domain/dynamic-private.ts; cross-module imports must target application/public.ts',
        'modules/auth/api/runtime.controller.ts has a non-literal import() dependency; architecture dependencies must use string literals',
        'modules/auth/api/runtime.controller.ts has a non-literal require() dependency; architecture dependencies must use string literals',
        'modules/auth/domain/runtime.ts has a non-literal import() dependency; architecture dependencies must use string literals',
        'modules/auth/domain/runtime.ts has a non-literal require() dependency; architecture dependencies must use string literals',
      ];

      expect(
        expectedViolations.filter(
          (expectedViolation) => !violations.includes(expectedViolation),
        ),
      ).toEqual([]);
      expect(
        violations.some((violation) =>
          violation.startsWith('modules/auth/api/safe.controller.ts'),
        ),
      ).toBe(false);
      expect(
        violations.some((violation) =>
          violation.includes('shared/safe.barrel'),
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
});
