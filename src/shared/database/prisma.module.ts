import { Global, Module } from '@nestjs/common';
import { PrismaAuditWriter } from '../audit/prisma-audit-writer';
import { AUDIT_WRITER } from '../audit/audit-writer';
import { AppConfigModule } from '../config/app-config.module';
import { APP_CONFIG } from '../config/app-config.schema';
import { IDEMPOTENCY_STORE } from '../idempotency/idempotency-store';
import { PrismaIdempotencyAdapter } from '../idempotency/prisma-idempotency.adapter';
import { DATABASE_READINESS } from './database-readiness';
import { createPrismaService, PrismaClientService } from './prisma.service';
import { TransactionRunner } from './transaction-runner';

@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: PrismaClientService,
      inject: [APP_CONFIG],
      useFactory: createPrismaService,
    },
    TransactionRunner,
    PrismaAuditWriter,
    PrismaIdempotencyAdapter,
    { provide: AUDIT_WRITER, useExisting: PrismaAuditWriter },
    { provide: IDEMPOTENCY_STORE, useExisting: PrismaIdempotencyAdapter },
    { provide: DATABASE_READINESS, useExisting: PrismaClientService },
  ],
  exports: [
    PrismaClientService,
    TransactionRunner,
    AUDIT_WRITER,
    IDEMPOTENCY_STORE,
    DATABASE_READINESS,
  ],
})
export class PrismaModule {}
