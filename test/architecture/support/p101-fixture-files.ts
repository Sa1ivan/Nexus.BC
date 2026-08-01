export const p101FixtureFiles: Readonly<Record<string, string>> = {
  'generated/prisma/index.ts': `
    export interface PrismaClient {}
  `,
  'shared/audit/prisma-audit-writer.ts': `
    import type { PrismaClient } from '@prisma/client';
    export type AuditClient = PrismaClient;
  `,
  'shared/audit/prisma-writer.ts': `
    import type { PrismaClient } from '@prisma/client';
    export type DeniedAuditClient = PrismaClient;
  `,
  'shared/idempotency/prisma-idempotency.adapter.ts': `
    import type { PrismaClient } from '@prisma/client';
    export type IdempotencyClient = PrismaClient;
  `,
  'shared/idempotency/prisma-idempotency-writer.ts': `
    import type { PrismaClient } from '@prisma/client';
    export type DeniedIdempotencyClient = PrismaClient;
  `,
  'shared/provider-derived.ts': `
    import type { S3Client } from '@aws-sdk/client-s3';
    import type { Resend } from 'resend';
    import type { PrismaClient } from '@prisma/client';

    export type StorageAlias = S3Client;
    export interface StoragePort extends StorageAlias {}
    export type StorageMap<T> = { [K in keyof T]: StoragePort };
    export type StorageConditional<T> = T extends StorageAlias
      ? StorageMap<T>
      : never;
    export interface MailPort { readonly client: Resend }
    export type MailAlias = MailPort;
    export type DataAlias = PrismaClient;
    export interface DataPort extends DataAlias {}
    export class DataClass extends PrismaClient {}
    export type DataMap<T> = { [K in keyof T]: DataPort };
    export type DataConditional<T> = T extends DataAlias ? DataMap<T> : never;
    export type DataReference = Readonly<DataConditional<DataAlias>>;
  `,
  'shared/restricted.barrel.ts': `
    export * as ProviderTypes from './provider-derived';
    export {
      DataReference,
      MailAlias,
      StorageConditional,
    } from './provider-derived';
  `,
  'shared/cycle-a.ts': `
    export * from './cycle-b';
  `,
  'shared/cycle-b.ts': `
    export * from './cycle-a';
    export { CYCLE_PRIVATE } from '../modules/sites/domain/private';
  `,
  'shared/module-barrel.ts': `
    export { AUTH_APPLICATION } from '../modules/auth/application/private';
    export { SITE_PRIVATE } from '../modules/sites/domain/private';
    export { CYCLE_PRIVATE } from './cycle-a';
    export const SAFE_SHARED = true;
  `,
  'shared/shared-contract.ts': `
    export interface SharedContract {}
  `,
  'modules/auth/application/private.ts': `
    export interface AuthApplicationContract {}
    export const AUTH_APPLICATION = true;
  `,
  'modules/auth/application/derived-consumer.ts': `
    import type {
      DataClass,
      DataReference,
      MailAlias,
      StorageConditional,
    } from '../../../shared/provider-derived';
    export type ApplicationClass = DataClass;
    export type ApplicationData = DataReference;
    export type ApplicationMail = MailAlias;
    export type ApplicationStorage = StorageConditional<string>;
  `,
  'modules/auth/application/local-generated-client.ts': `
    import type { PrismaClient } from '../../../generated/prisma';
    export type GeneratedClient = PrismaClient;
  `,
  'modules/auth/application/import-types.ts': `
    export type Data = import('../../../shared/restricted.barrel').DataReference;
    export type Mail = import('../../../shared/restricted.barrel').MailAlias;
    export type Storage = import('../../../shared/restricted.barrel').StorageConditional<string>;
    export type QualifiedStorage = import('../../../shared/restricted.barrel').ProviderTypes.StoragePort;
    export type Adapter = import('@prisma/adapter-pg').PrismaPg;
    export type DynamicModule = typeof import('./safe-contract');
  `,
  'modules/auth/application/safe-contract.ts': `
    export interface SafeApplicationContract {}
  `,
  'modules/auth/application/good-contracts.ts': `
    export interface GoodPort {}
    export type GoodDto = Readonly<{ id: string }>;
    export const GOOD_TOKEN = Symbol('GOOD_TOKEN');
  `,
  'modules/auth/application/bad-exports.ts': `
    export class ConcreteApplicationService {}
    export function concreteFactory(): object { return {}; }
    export const PLAIN_VALUE = 1;
  `,
  'modules/auth/application/public.ts': `
    export interface LocalPort {}
    export type LocalDto = Readonly<{ id: string }>;
    export const LOCAL_TOKEN = Symbol('LOCAL_TOKEN');
    export const LOCAL_TOKEN_FOR = Symbol.for('LOCAL_TOKEN_FOR');
    export class LocalConcreteService {}
    export function localFactory(): object { return {}; }
    export type { GoodDto, GoodPort } from './good-contracts';
    export { GOOD_TOKEN } from './good-contracts';
    export { DomainContract } from '../domain/public-source';
    export { ApiContract } from '../api/public-source';
    export { InfrastructureContract } from '../infrastructure/public-source';
    export { SharedContract } from '../../../shared/shared-contract';
    export {
      ConcreteApplicationService,
      PLAIN_VALUE,
      concreteFactory,
    } from './bad-exports';
  `,
  'modules/auth/domain/private.ts': `
    export const AUTH_PRIVATE = true;
  `,
  'modules/auth/domain/public-source.ts': `
    export interface DomainContract {}
  `,
  'modules/auth/domain/local-barrel.ts': `
    export { SITE_PRIVATE as LOCALLY_LAUNDERED } from '../../sites/domain/private';
  `,
  'modules/auth/domain/laundered-consumer.ts': `
    import {
      AUTH_APPLICATION,
      CYCLE_PRIVATE,
      SAFE_SHARED,
      SITE_PRIVATE,
    } from '../../../shared/module-barrel';
    import { LOCALLY_LAUNDERED } from './local-barrel';
    void AUTH_APPLICATION;
    void CYCLE_PRIVATE;
    void SAFE_SHARED;
    void SITE_PRIVATE;
    void LOCALLY_LAUNDERED;
    void import('../../../shared/module-barrel');
  `,
  'modules/auth/domain/import-types.ts': `
    export type ForbiddenApplication = import('../../../shared/module-barrel').AUTH_APPLICATION;
    export type CrossModule = import('../../../shared/module-barrel').SITE_PRIVATE;
    export type SafeShared = import('../../../shared/module-barrel').SAFE_SHARED;
  `,
  'modules/auth/domain/nonliteral-imports.ts': `
    const dependency = '../application/private';
    void import(dependency);
    void require(dependency);
  `,
  'modules/auth/domain/shadowed-require.ts': `
    export {};
    const require = (specifier: string): string => specifier;
    const dependency = '../application/private';
    void require(dependency);
  `,
  'modules/auth/api/public-source.ts': `
    export interface ApiContract {}
  `,
  'modules/auth/api/namespace-entry.ts': `
    import * as Nest from '@nestjs/common';
    import type { S3Client } from '@aws-sdk/client-s3';
    @Nest.Controller()
    export class NamespaceEntry { declare client: S3Client }
  `,
  'modules/auth/api/alias-entry.ts': `
    import { Controller } from '@nestjs/common';
    import type { Resend } from 'resend';
    const ApiController = Controller;
    @ApiController()
    export class AliasEntry { declare mailer: Resend }
  `,
  'modules/auth/api/initializer-wrapper-entry.ts': `
    import { Controller } from '@nestjs/common';
    import type { DataReference } from '../../../shared/provider-derived';
    const ApiController = (): ClassDecorator => Controller();
    @ApiController()
    export class InitializerWrapperEntry { declare data: DataReference }
  `,
  'modules/auth/api/function-wrapper-entry.ts': `
    import { Controller } from '@nestjs/common';
    import type { StorageConditional } from '../../../shared/provider-derived';
    function ApiController(): ClassDecorator { return Controller(); }
    @ApiController()
    export class FunctionWrapperEntry {
      declare storage: StorageConditional<string>;
    }
  `,
  'modules/auth/api/safe-decorator-entry.ts': `
    import { Controller } from '@nestjs/common';
    import type { DataReference } from '../../../shared/provider-derived';
    const applyDecorators = (
      ..._decorators: readonly ClassDecorator[]
    ): ClassDecorator => () => undefined;
    @applyDecorators(Controller())
    export class SafeDecoratorEntry { declare data: DataReference }
  `,
  'modules/auth/infrastructure/public-source.ts': `
    export interface InfrastructureContract {}
  `,
  'modules/auth/infrastructure/wrong-providers.ts': `
    import type { S3Client } from '@aws-sdk/client-s3';
    import type { Resend } from '@resend/node';
    export type WrongStorage = S3Client;
    export type WrongMail = Resend;
  `,
  'modules/sites/domain/private.ts': `
    export interface SiteContract {}
    export const CYCLE_PRIVATE = true;
    export const SITE_PRIVATE = true;
  `,
  'modules/media/infrastructure/aws-owner.ts': `
    import type { S3Client } from '@aws-sdk/client-s3';
    export type OwnedStorage = S3Client;
  `,
  'modules/media/infrastructure/resend-denied.ts': `
    import type { Resend } from 'resend';
    export type WrongOwnerMail = Resend;
  `,
  'modules/notifications/infrastructure/resend-owner.ts': `
    import type { Resend } from '@resend/node';
    export type OwnedMail = Resend;
  `,
  'modules/notifications/infrastructure/aws-denied.ts': `
    import type { S3Client } from '@aws-sdk/client-s3';
    export type WrongOwnerStorage = S3Client;
  `,
};
