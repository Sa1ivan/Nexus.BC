import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { AppConfigModule } from '../../src/shared/config/app-config.module';
import { PrismaModule } from '../../src/shared/database/prisma.module';
import { PrismaClientService } from '../../src/shared/database/prisma.service';
import {
  TransactionRunner,
  type TransactionContext,
} from '../../src/shared/database/transaction-runner';
import {
  AUDIT_WRITER,
  type AuditWriter,
  type LeadSubmittedAuditEvent,
  type MediaDeletionMarkedAuditEvent,
} from '../../src/shared/audit/audit-writer';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function leadSubmittedEvent(
  overrides: Partial<LeadSubmittedAuditEvent> = {},
): LeadSubmittedAuditEvent {
  return {
    eventId: randomUUID(),
    workspaceId: randomUUID(),
    actorUserId: randomUUID(),
    action: 'LEAD_SUBMITTED',
    resourceType: 'Lead',
    resourceId: randomUUID(),
    metadata: {
      releaseId: randomUUID(),
      outcome: 'accepted',
    },
    requestId: randomUUID(),
    ...overrides,
  };
}

function mediaDeletionMarkedEvent(): MediaDeletionMarkedAuditEvent {
  return {
    eventId: randomUUID(),
    workspaceId: randomUUID(),
    actorUserId: randomUUID(),
    action: 'MEDIA_DELETION_MARKED',
    resourceType: 'MediaAsset',
    resourceId: randomUUID(),
    metadata: { outcome: 'deleting' },
    requestId: randomUUID(),
  };
}

describe('transactional append-only audit sequence', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let transactions: TransactionRunner;
  let auditWriter: AuditWriter;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get<PrismaClient>(PrismaClientService);
    transactions = app.get(TransactionRunner);
    auditWriter = app.get<AuditWriter>(AUDIT_WRITER);
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditEvent" DISABLE TRIGGER USER',
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "AuditSequence" DISABLE TRIGGER USER',
    );
    try {
      await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "AuditEvent", "AuditSequence"',
      );
      await prisma.auditSequence.create({
        data: { id: 1, nextValue: 1n },
      });
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditEvent" ENABLE TRIGGER USER',
      );
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "AuditSequence" ENABLE TRIGGER USER',
      );
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects forged and expired transaction contexts', async () => {
    const event = leadSubmittedEvent();

    await expect(
      auditWriter.append({} as TransactionContext, event),
    ).rejects.toThrow('active TransactionContext');

    let expiredContext: TransactionContext | undefined;
    await transactions.run((context) => {
      expiredContext = context;
      return Promise.resolve();
    });

    await expect(
      auditWriter.append(expiredContext as TransactionContext, event),
    ).rejects.toThrow('active TransactionContext');
    await expect(prisma.auditEvent.count()).resolves.toBe(0);
  });

  it('rejects metadata outside the LEAD_SUBMITTED allowlist before writing', async () => {
    const unsafeEvent = leadSubmittedEvent({
      metadata: {
        releaseId: randomUUID(),
        outcome: 'accepted',
        email: 'secret@example.test',
      },
    } as unknown as Partial<LeadSubmittedAuditEvent>);

    await expect(
      transactions.run((context) => auditWriter.append(context, unsafeEvent)),
    ).rejects.toThrow('metadata');

    await expect(prisma.auditEvent.count()).resolves.toBe(0);
    await expect(
      prisma.auditSequence.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({ nextValue: 1n });
  });

  it('allows only outcome metadata for media deletion audit events', async () => {
    const event = mediaDeletionMarkedEvent();
    await transactions.run((context) => auditWriter.append(context, event));

    await expect(
      prisma.auditEvent.findUniqueOrThrow({
        where: { eventId: event.eventId },
        select: { action: true, resourceType: true, metadata: true },
      }),
    ).resolves.toEqual({
      action: 'MEDIA_DELETION_MARKED',
      resourceType: 'MediaAsset',
      metadata: { outcome: 'deleting' },
    });

    const unsafe = {
      ...mediaDeletionMarkedEvent(),
      metadata: {
        outcome: 'deleting',
        objectKey: 'workspaces/private/object.png',
      },
    } as unknown as MediaDeletionMarkedAuditEvent;
    await expect(
      transactions.run((context) => auditWriter.append(context, unsafe)),
    ).rejects.toThrow('not allowlisted');

    const unsafeRequestId = {
      ...mediaDeletionMarkedEvent(),
      requestId: 'workspaces/private/object.png',
    };
    await expect(
      transactions.run((context) =>
        auditWriter.append(context, unsafeRequestId),
      ),
    ).rejects.toThrow('not allowlisted');
    await expect(prisma.auditEvent.count()).resolves.toBe(1);
  });

  it('rejects non-UUID release metadata that could disguise contact data', async () => {
    const unsafeEvent = leadSubmittedEvent({
      metadata: {
        releaseId: 'secret@example.test',
        outcome: 'accepted',
      },
    });

    await expect(
      transactions.run((context) => auditWriter.append(context, unsafeEvent)),
    ).rejects.toThrow('metadata');

    await expect(prisma.auditEvent.count()).resolves.toBe(0);
    await expect(
      prisma.auditSequence.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({ nextValue: 1n });
  });

  it('rejects a non-UUID Lead resource id that could disguise contact data', async () => {
    const unsafeEvent = leadSubmittedEvent({
      resourceId: '+79990000000',
    });

    await expect(
      transactions.run((context) => auditWriter.append(context, unsafeEvent)),
    ).rejects.toThrow('resourceId');

    await expect(prisma.auditEvent.count()).resolves.toBe(0);
    await expect(
      prisma.auditSequence.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({ nextValue: 1n });
  });

  it('appends exactly once and keeps eventId and sequence unique', async () => {
    const event = leadSubmittedEvent();

    const appended = await transactions.run((context) =>
      auditWriter.append(context, event),
    );
    expect(appended.sequence).toBe(1n);

    await expect(
      transactions.run((context) => auditWriter.append(context, event)),
    ).rejects.toThrow();

    await expect(prisma.auditEvent.count()).resolves.toBe(1);
    await expect(
      prisma.auditSequence.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({ nextValue: 2n });
  });

  it('rolls back the event and reuses its uncommitted sequence number', async () => {
    await expect(
      transactions.run(async (context) => {
        await auditWriter.append(context, leadSubmittedEvent());
        throw new Error('business rollback');
      }),
    ).rejects.toThrow('business rollback');

    const appended = await transactions.run((context) =>
      auditWriter.append(context, leadSubmittedEvent()),
    );

    expect(appended.sequence).toBe(1n);
    await expect(prisma.auditEvent.count()).resolves.toBe(1);
  });

  it('locks the singleton allocator until commit and commits without gaps', async () => {
    const firstAllocated = deferred<void>();
    const allowFirstCommit = deferred<void>();
    const secondAllocated = deferred<void>();
    const firstEvent = leadSubmittedEvent();
    const secondEvent = leadSubmittedEvent();

    const firstTransaction = transactions.run(async (context) => {
      await auditWriter.append(context, firstEvent);
      firstAllocated.resolve();
      await allowFirstCommit.promise;
    });
    await firstAllocated.promise;

    const secondTransaction = transactions.run(async (context) => {
      await auditWriter.append(context, secondEvent);
      secondAllocated.resolve();
    });

    const allocationWhileLocked = await Promise.race([
      secondAllocated.promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(allocationWhileLocked).toBe(false);

    allowFirstCommit.resolve();
    await Promise.all([firstTransaction, secondTransaction]);

    const events = await prisma.auditEvent.findMany({
      orderBy: { sequence: 'asc' },
      select: { eventId: true, sequence: true },
    });
    expect(events).toEqual([
      { eventId: firstEvent.eventId, sequence: 1n },
      { eventId: secondEvent.eventId, sequence: 2n },
    ]);
  });

  it('enforces the singleton sequence row in PostgreSQL', async () => {
    await expect(
      prisma.auditSequence.create({ data: { id: 2, nextValue: 1n } }),
    ).rejects.toThrow();
    await expect(prisma.auditSequence.count()).resolves.toBe(1);
  });

  it('rejects direct inserts that bypass the audit allocator', async () => {
    const event = leadSubmittedEvent();

    await expect(
      prisma.auditEvent.create({
        data: {
          eventId: event.eventId,
          sequence: 99n,
          workspaceId: event.workspaceId,
          actorUserId: event.actorUserId,
          action: event.action,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          metadata: event.metadata,
          requestId: event.requestId,
        },
      }),
    ).rejects.toThrow();

    await expect(prisma.auditEvent.count()).resolves.toBe(0);
  });

  it('rejects direct sequence mutation and deletion', async () => {
    await expect(
      prisma.auditSequence.update({
        where: { id: 1 },
        data: { nextValue: 99n },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.auditSequence.delete({ where: { id: 1 } }),
    ).rejects.toThrow();

    await expect(
      prisma.auditSequence.findUniqueOrThrow({ where: { id: 1 } }),
    ).resolves.toMatchObject({ nextValue: 1n });
  });

  it('rejects truncation of the append-only audit log', async () => {
    await transactions.run((context) =>
      auditWriter.append(context, leadSubmittedEvent()),
    );

    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE "AuditEvent"'),
    ).rejects.toThrow();
    await expect(prisma.auditEvent.count()).resolves.toBe(1);
  });

  it('rejects update and delete mutations of persisted audit events', async () => {
    const event = leadSubmittedEvent();
    await transactions.run((context) => auditWriter.append(context, event));

    await expect(
      prisma.auditEvent.update({
        where: { eventId: event.eventId },
        data: { resourceId: randomUUID() },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.auditEvent.delete({
        where: { eventId: event.eventId },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.auditEvent.findUniqueOrThrow({
        where: { eventId: event.eventId },
      }),
    ).resolves.toMatchObject({ resourceId: event.resourceId, sequence: 1n });
  });
});
