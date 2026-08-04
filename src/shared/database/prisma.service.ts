import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { APP_CONFIG, type AppConfig } from '../config/app-config.schema';
import {
  checkDatabaseReadiness,
  type DatabaseReadiness,
} from './database-readiness';

export const PrismaClientService = Symbol('PrismaClientService');

export interface PrismaTransactionHost {
  $transaction<T>(work: (client: unknown) => Promise<T>): Promise<T>;
}

@Injectable()
class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy, DatabaseReadiness
{
  constructor(@Inject(APP_CONFIG) configuration: AppConfig) {
    super({
      adapter: new PrismaPg({
        connectionString: configuration.databaseUrl,
        connectionTimeoutMillis: 500,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch {
      // The process stays live while readiness reports an unavailable database.
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async isReady(): Promise<boolean> {
    return checkDatabaseReadiness(() => this.$queryRaw`SELECT 1`);
  }
}

export function createPrismaService(configuration: AppConfig) {
  return new PrismaService(configuration);
}
