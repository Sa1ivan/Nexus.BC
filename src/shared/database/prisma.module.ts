import { Global, Module } from '@nestjs/common';
import { PrismaAuditWriter } from '../audit/prisma-audit-writer';
import { AUDIT_WRITER } from '../audit/audit-writer';
import { AppConfigModule } from '../config/app-config.module';
import { APP_CONFIG } from '../config/app-config.schema';
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
    { provide: AUDIT_WRITER, useExisting: PrismaAuditWriter },
    { provide: DATABASE_READINESS, useExisting: PrismaClientService },
  ],
  exports: [
    PrismaClientService,
    TransactionRunner,
    AUDIT_WRITER,
    DATABASE_READINESS,
  ],
})
export class PrismaModule {}
