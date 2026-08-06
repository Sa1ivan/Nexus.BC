import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../../generated/prisma/client';
import { APP_CONFIG, type AppConfig } from '../config/app-config.schema';
import {
  DatabaseReadinessCoordinator,
  type DatabaseReadiness,
} from './database-readiness';
import { probeDatabaseConnection } from './cancellable-database-probe';

export const PrismaClientService = Symbol('PrismaClientService');

export interface PrismaTransactionHost {
  $transaction<T>(work: (client: unknown) => Promise<T>): Promise<T>;
}

@Injectable()
class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy, DatabaseReadiness
{
  private readonly readiness: DatabaseReadinessCoordinator;
  private readonly readinessPool: Pool;

  constructor(@Inject(APP_CONFIG) configuration: AppConfig) {
    super({
      adapter: new PrismaPg({
        connectionString: configuration.databaseUrl,
        connectionTimeoutMillis: 500,
      }),
    });
    this.readinessPool = new Pool({
      connectionString: configuration.databaseUrl,
      connectionTimeoutMillis: 500,
      max: 1,
      idleTimeoutMillis: 1_000,
      allowExitOnIdle: true,
      application_name: 'nexus-readiness',
    });
    this.readiness = new DatabaseReadinessCoordinator((signal) =>
      probeDatabaseConnection(this.readinessPool, signal),
    );
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch {
      // The process stays live while readiness reports an unavailable database.
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.$disconnect(), this.readinessPool.end()]);
  }

  async isReady(): Promise<boolean> {
    return this.readiness.isReady();
  }
}

export function createPrismaService(configuration: AppConfig) {
  return new PrismaService(configuration);
}
