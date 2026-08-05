import { Global, Module } from '@nestjs/common';
import { NOTIFICATION_ENQUEUE } from './application/public';
import { PrismaOutbox } from './infrastructure/prisma-outbox';

@Global()
@Module({
  providers: [
    PrismaOutbox,
    { provide: NOTIFICATION_ENQUEUE, useExisting: PrismaOutbox },
  ],
  exports: [NOTIFICATION_ENQUEUE],
})
export class NotificationsModule {}
