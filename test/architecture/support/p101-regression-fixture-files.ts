export const p101RegressionFixtureFiles: Readonly<Record<string, string>> = {
  'modules/sites/application/contracts.ts': `
    export interface SitePort { readonly id: string }
  `,
  'modules/sites/application/public.ts': `
    export type { SitePort } from './contracts';
    export const SITE_TOKEN = Symbol('SITE_TOKEN');
  `,
  'shared/public-route-barrel.ts': `
    export { SITE_TOKEN } from '../modules/sites/application/public';
  `,
  'modules/auth/application/legal-public-consumer.ts': `
    import type { SitePort } from '../../sites/application/public';
    export type LegalSitePort = SitePort;
  `,
  'modules/auth/application/shared-public-consumer.ts': `
    import { SITE_TOKEN } from '../../../shared/public-route-barrel';
    void SITE_TOKEN;
  `,
  'modules/sites/domain/type-private.ts': `
    export interface SiteTypePrivate { readonly id: string }
  `,
  'shared/type-wrapper.ts': `
    import type { SiteTypePrivate } from '../modules/sites/domain/type-private';
    export type HiddenType = SiteTypePrivate;
  `,
  'modules/auth/domain/type-wrapper-consumer.ts': `
    import type { HiddenType } from '../../../shared/type-wrapper';
    export type ConsumedType = HiddenType;
  `,
  'modules/sites/domain/interface-private.ts': `
    export interface SiteInterfacePrivate { readonly id: string }
  `,
  'shared/interface-wrapper.ts': `
    import type { SiteInterfacePrivate } from '../modules/sites/domain/interface-private';
    export interface HiddenInterface extends SiteInterfacePrivate {}
  `,
  'modules/auth/domain/interface-wrapper-consumer.ts': `
    import type { HiddenInterface } from '../../../shared/interface-wrapper';
    export type ConsumedInterface = HiddenInterface;
  `,
  'modules/sites/domain/value-private.ts': `
    export const SITE_VALUE_PRIVATE = 1;
  `,
  'shared/value-wrapper.ts': `
    import { SITE_VALUE_PRIVATE } from '../modules/sites/domain/value-private';
    export const HIDDEN_VALUE = SITE_VALUE_PRIVATE;
  `,
  'modules/auth/domain/value-wrapper-consumer.ts': `
    import { HIDDEN_VALUE } from '../../../shared/value-wrapper';
    void HIDDEN_VALUE;
  `,
  'modules/sites/domain/default-private.ts': `
    export const SITE_DEFAULT_PRIVATE = 1;
  `,
  'shared/default-wrapper.ts': `
    import { SITE_DEFAULT_PRIVATE } from '../modules/sites/domain/default-private';
    export default SITE_DEFAULT_PRIVATE;
  `,
  'modules/auth/domain/default-wrapper-consumer.ts': `
    import HIDDEN_DEFAULT from '../../../shared/default-wrapper';
    void HIDDEN_DEFAULT;
  `,
  'modules/auth/domain/public-entity.ts': `
    export interface DomainEntity { readonly id: string }
  `,
  'modules/auth/application/concrete-service.ts': `
    export class ConcreteService {}
  `,
  'modules/auth/application/public-contracts.ts': `
    import type { DomainEntity } from '../domain/public-entity';
    import type { ConcreteService } from './concrete-service';
    export type HiddenDomain = DomainEntity;
    export interface HiddenDomainInterface extends DomainEntity {}
    export type HiddenConcrete = ConcreteService;
  `,
  'modules/auth/application/public.ts': `
    export type {
      HiddenConcrete,
      HiddenDomain,
      HiddenDomainInterface,
    } from './public-contracts';
    export const { RUNTIME_VALUE } = { RUNTIME_VALUE: 1 };
  `,
  'shared/audit/prisma-audit-writer.ts': `
    import type { PrismaClient } from '@prisma/client';
    import type { RecursiveB } from '../database/recursive-b';
    export class AuditGateway {
      declare readonly client: PrismaClient;
      execute(client: PrismaClient): PrismaClient { return client; }
    }
    export function expose(client: PrismaClient): PrismaClient { return client; }
    export type RecursiveA = RecursiveB;
  `,
  'shared/database/recursive-b.ts': `
    import type { PrismaClient } from '@prisma/client';
    import type { RecursiveA } from '../audit/prisma-audit-writer';
    export type RecursiveB = RecursiveA | PrismaClient;
  `,
  'modules/auth/application/adapter-consumer.ts': `
    import {
      AuditGateway,
      expose,
    } from '../../../shared/audit/prisma-audit-writer';
    export type Gateway = AuditGateway;
    void expose;
  `,
  'modules/auth/application/recursive-consumer.ts': `
    import type { RecursiveB } from '../../../shared/database/recursive-b';
    import type { RecursiveA } from '../../../shared/audit/prisma-audit-writer';
    export type First = RecursiveB;
    export type Second = RecursiveA;
  `,
  'shared/database.ts': `
    import type { PrismaClient } from '@prisma/client';
    export type DisallowedDatabaseFile = PrismaClient;
  `,
  'shared/audit/infrastructure/r2-recovery-audit-storage.ts': `
    import type { S3Client } from '@aws-sdk/client-s3';
    export type RecoveryStorageClient = S3Client;
  `,
  'shared/audit/infrastructure/r2-recovery-audit-store.ts': `
    import type { S3Client } from '@aws-sdk/client-s3';
    export type DisallowedRecoveryStorageClient = S3Client;
  `,
  'modules/auth/api/nested-controller-entry.ts': `
    import { Controller } from '@nestjs/common';
    import type { S3Client } from '@aws-sdk/client-s3';
    function ApiController(): ClassDecorator {
      if (Math.random() > 0.5) {
        return Controller();
      }
      return () => undefined;
    }
    @ApiController()
    export class NestedControllerEntry { declare client: S3Client }
  `,
  'modules/auth/api/bound-controller-entry.ts': `
    import { Controller } from '@nestjs/common';
    import type { Resend } from 'resend';
    const ApiController = Controller.bind(null);
    @ApiController()
    export class BoundControllerEntry { declare mailer: Resend }
  `,
  'modules/auth/api/composite-controller-entry.ts': `
    import {
      applyDecorators as nestApplyDecorators,
      Controller,
    } from '@nestjs/common';
    import type { S3Client } from '@aws-sdk/client-s3';
    @nestApplyDecorators(Controller())
    export class CompositeControllerEntry { declare client: S3Client }
  `,
  'modules/auth/application/handler-use-cases.ts': `
    export class GoodUseCase { execute(): string { return 'good'; } }
    export class SecondUseCase { execute(): string { return 'second'; } }
  `,
  'modules/auth/application/handler-functions.ts': `
    export function runUseCase(): string { return 'application'; }
  `,
  'modules/auth/domain/handler-domain-service.ts': `
    export class DomainService { execute(): string { return 'domain'; } }
  `,
  'modules/auth/domain/handler-functions.ts': `
    export function runDomain(): string { return 'domain'; }
  `,
  'modules/auth/api/handler-call-barrel.ts': `
    export { runUseCase } from '../application/handler-functions';
    export { runDomain } from '../domain/handler-functions';
  `,
  'modules/auth/api/handler-entry.ts': `
    import { Controller, Get } from '@nestjs/common';
    import { GoodUseCase, SecondUseCase } from '../application/handler-use-cases';
    import { runUseCase as directRunUseCase } from '../application/handler-functions';
    import { DomainService } from '../domain/handler-domain-service';
    import { runDomain as directRunDomain } from '../domain/handler-functions';
    import { runDomain, runUseCase } from './handler-call-barrel';
    @Controller()
    export class HandlerEntry {
      constructor(
        private readonly good: GoodUseCase,
        private readonly second: SecondUseCase,
        private readonly domain: DomainService,
      ) {}
      @Get('safe') safe(): string { return this.good.execute(); }
      @Get('zero') zero(): string { return 'zero'; }
      @Get('two') two(): string {
        return this.good.execute() + this.second.execute();
      }
      @Get('wrong') wrong(): string { return this.domain.execute(); }
      @Get('alias-wrong') aliasWrong(): string {
        const hidden = this.domain;
        hidden.execute();
        return this.good.execute();
      }
      @Get('property-alias-wrong') propertyAliasWrong(): string {
        const hidden = this.domain.execute;
        hidden();
        return this.good.execute();
      }
      @Get('destructured-wrong') destructuredWrong(): string {
        const { domain } = this;
        domain.execute();
        return this.good.execute();
      }
      @Get('reexport-wrong') reexportWrong(): string {
        runDomain();
        return runUseCase();
      }
      @Get('direct-import-wrong') directImportWrong(): string {
        directRunDomain();
        return directRunUseCase();
      }
      @Get('safe-alias') safeAlias(): string {
        const useCase = this.good;
        return useCase.execute();
      }
      @Get('safe-destructured') safeDestructured(): string {
        const { good } = this;
        return good.execute();
      }
      @Get('safe-property-alias') safePropertyAlias(): string {
        const { execute } = this.good;
        return execute();
      }
      @Get('safe-reexport-alias') safeReexportAlias(): string {
        const useCase = runUseCase;
        return useCase();
      }
      @Get('safe-direct-import') safeDirectImport(): string {
        return directRunUseCase();
      }
      @Get('reflect-apply-wrong') reflectApplyWrong(): string {
        Reflect.apply(this.domain.execute, this.domain, []);
        return this.good.execute();
      }
      @Get('reflect-construct-wrong') reflectConstructWrong(): string {
        Reflect.construct(DomainService, []);
        return this.good.execute();
      }
      @Get('safe-reflect-apply') safeReflectApply(): string {
        return Reflect.apply(this.good.execute, this.good, []);
      }
      @Get('safe-reflect-construct') safeReflectConstruct(): GoodUseCase {
        return Reflect.construct(GoodUseCase, []);
      }
      helper(): string { return 'not a route'; }
    }
  `,
  'modules/auth/api/handler-shadowed-reflect-entry.ts': `
    import { Controller, Get } from '@nestjs/common';
    import { GoodUseCase } from '../application/handler-use-cases';
    import { DomainService } from '../domain/handler-domain-service';
    const Reflect = {} as Pick<
      typeof globalThis.Reflect,
      'apply' | 'construct'
    >;
    @Controller()
    export class HandlerShadowedReflectEntry {
      constructor(
        private readonly good: GoodUseCase,
        private readonly domain: DomainService,
      ) {}
      @Get() control(): string {
        Reflect.apply(this.domain.execute, this.domain, []);
        Reflect.construct(DomainService, []);
        return this.good.execute();
      }
    }
  `,
  'modules/auth/api/route-decorator-barrel.ts': `
    export { Get as ReexportedGet } from '@nestjs/common';
  `,
  'modules/auth/api/route-wrapper-entry.ts': `
    import * as Nest from '@nestjs/common';
    import {
      applyDecorators as nestApplyDecorators,
      Controller,
      Get,
      Post,
    } from '@nestjs/common';
    import { ReexportedGet } from './route-decorator-barrel';
    const NamespaceAlias = Nest;
    const RouteObject = { Get };
    const PropertyAlias = RouteObject.Get;
    const { Get: NamespaceDestructuredRoute } = Nest;
    const { Get: PropertyDestructuredRoute } = RouteObject;
    const AliasRoute = Get;
    const BoundRoute = Get.bind(null);
    function NestedBoundRoute(): MethodDecorator {
      return Get.bind(null)();
    }
    function NestedRoute(): MethodDecorator {
      if (Math.random() > 0.5) {
        return ReexportedGet();
      }
      return Post();
    }
    const ArrowRoute = (): MethodDecorator => {
      if (Math.random() > 0.5) {
        return Nest.Get();
      }
      return AliasRoute();
    };
    const CompositeRoute = (): MethodDecorator =>
      nestApplyDecorators(Get());
    const applyDecorators = (
      ..._decorators: readonly MethodDecorator[]
    ): MethodDecorator => () => undefined;
    @Controller()
    export class RouteWrapperEntry {
      @Get() direct(): string { return 'direct'; }
      @Nest.Get() namespace(): string { return 'namespace'; }
      @NamespaceAlias.Get() namespaceAlias(): string { return 'namespace alias'; }
      @RouteObject.Get() shorthandProperty(): string { return 'shorthand property'; }
      @PropertyAlias() propertyAlias(): string { return 'property alias'; }
      @NamespaceDestructuredRoute() namespaceDestructured(): string {
        return 'namespace destructured';
      }
      @PropertyDestructuredRoute() propertyDestructured(): string {
        return 'property destructured';
      }
      @AliasRoute() alias(): string { return 'alias'; }
      @ReexportedGet() reexport(): string { return 'reexport'; }
      @NestedRoute() nested(): string { return 'nested'; }
      @ArrowRoute() arrow(): string { return 'arrow'; }
      @BoundRoute() bound(): string { return 'bound'; }
      @NestedBoundRoute() nestedBound(): string { return 'nested bound'; }
      @CompositeRoute() composite(): string { return 'composite'; }
      @applyDecorators(Get()) localCompositeControl(): string {
        return 'not a route';
      }
      helper(): string { return 'not a route'; }
    }
  `,
  'modules/sites/domain/symlink-private.ts': `
    export const SITE_SYMLINK_PRIVATE = 1;
  `,
  'modules/auth/domain/symlink-consumer.ts': `
    import { SITE_SYMLINK_PRIVATE } from '../../../shared/private-link';
    void SITE_SYMLINK_PRIVATE;
  `,
};
