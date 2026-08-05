import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool, type PoolClient } from 'pg';
import {
  NOTIFICATION_ENQUEUE,
  type AuthNotification,
  type NotificationEnqueue,
} from '../../src/modules/notifications/application/public';
import { NotificationsModule } from '../../src/modules/notifications/notifications.module';
import { PrismaModule } from '../../src/shared/database/prisma.module';
import { PrismaClientService } from '../../src/shared/database/prisma.service';
import {
  TransactionRunner,
  type TransactionContext,
} from '../../src/shared/database/transaction-runner';

interface ColumnContract {
  readonly columnName: string;
  readonly dataType: string;
  readonly columnDefault: string | null;
  readonly isNullable: 'YES' | 'NO';
}

async function outboxColumns(client: PoolClient): Promise<ColumnContract[]> {
  const result = await client.query<{
    column_default: string | null;
    column_name: string;
    data_type: string;
    is_nullable: 'YES' | 'NO';
  }>(
    `SELECT column_name, data_type, column_default, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Outbox'
      ORDER BY ordinal_position`,
  );
  return result.rows.map(
    ({ column_default, column_name, data_type, is_nullable }) => ({
      columnName: column_name,
      dataType: data_type,
      columnDefault: column_default,
      isNullable: is_nullable,
    }),
  );
}

async function outboxIndexes(client: PoolClient): Promise<string[]> {
  const result = await client.query<{ indexdef: string }>(
    `SELECT indexdef
       FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'Outbox'
      ORDER BY indexname`,
  );
  return result.rows.map(({ indexdef }) => indexdef);
}

describe('notification Outbox schema', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    client = await pool.connect();
  });

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  it('creates the exact delivery states and Outbox columns', async () => {
    const stateResult = await client.query<{ enumlabel: string }>(
      `SELECT enumlabel
         FROM pg_enum
         JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
        WHERE pg_type.typname = 'OutboxDeliveryState'
        ORDER BY enumsortorder`,
    );
    expect(stateResult.rows.map(({ enumlabel }) => enumlabel)).toEqual([
      'READY',
      'SENDING',
      'UNKNOWN',
      'DELIVERED',
      'DEAD_LETTER',
      'CANCELLED',
    ]);

    expect(
      (await outboxColumns(client)).map(({ columnName }) => columnName),
    ).toEqual([
      'id',
      'eventId',
      'businessIdempotencyKey',
      'kind',
      'aggregateType',
      'aggregateId',
      'payload',
      'secretCiphertext',
      'secretExpiresAt',
      'secretRedactedAt',
      'availableAt',
      'state',
      'lockedUntil',
      'lockedBy',
      'claimToken',
      'attemptOrdinal',
      'attempts',
      'maxAttempts',
      'deliveredAt',
      'deadLetterAt',
      'cancelledAt',
      'lastErrorCode',
      'providerMessageId',
      'providerOutcomeCode',
      'providerOutcomeObservedAt',
      'providerIdempotencyExpiresAt',
      'createdAt',
    ]);
  });

  it('keeps payload JSON separate from optional ciphertext and enforces event identities', async () => {
    const columns = await outboxColumns(client);
    expect(
      columns.find(({ columnName }) => columnName === 'payload'),
    ).toMatchObject({
      dataType: 'jsonb',
      isNullable: 'NO',
    });
    expect(
      columns.find(({ columnName }) => columnName === 'secretCiphertext'),
    ).toMatchObject({ dataType: 'bytea', isNullable: 'YES' });
    expect(
      columns.find(({ columnName }) => columnName === 'state'),
    ).toMatchObject({
      columnDefault: '\'READY\'::"OutboxDeliveryState"',
      isNullable: 'NO',
    });
    expect(
      columns.find(({ columnName }) => columnName === 'attempts'),
    ).toMatchObject({
      columnDefault: '0',
      isNullable: 'NO',
    });
    expect(
      columns.find(({ columnName }) => columnName === 'maxAttempts'),
    ).toMatchObject({ columnDefault: '10', isNullable: 'NO' });

    const indexes = (await outboxIndexes(client)).join('\n');
    expect(indexes).toMatch(/UNIQUE.+"eventId"/u);
    expect(indexes).toMatch(/UNIQUE.+"businessIdempotencyKey"/u);
    expect(indexes).toMatch(
      /"deliveredAt", "deadLetterAt", "availableAt", "lockedUntil"/u,
    );
    expect(indexes).not.toMatch(/UNIQUE.+"kind".+"aggregateId"/u);
  });
});

interface OutboxTestClient {
  $executeRawUnsafe(statement: string): Promise<number>;
  $queryRawUnsafe<T>(
    statement: string,
    ...values: readonly unknown[]
  ): Promise<T>;
}

interface StoredOutboxRow {
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly attempts: number;
  readonly businessIdempotencyKey: string;
  readonly eventId: string;
  readonly kind: string;
  readonly maxAttempts: number;
  readonly payload: unknown;
  readonly secretCiphertext: Uint8Array | null;
  readonly secretExpiresAt: Date | null;
  readonly state: string;
}

function authNotification(
  overrides: Partial<AuthNotification> = {},
): AuthNotification {
  return {
    eventId: randomUUID(),
    kind: 'AUTH_EMAIL_VERIFICATION',
    userId: randomUUID(),
    tokenRecordId: randomUUID(),
    secretCiphertext: Uint8Array.from([1, 2, 3, 4]),
    secretExpiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe('transaction-aware notification enqueue boundary', () => {
  let app: INestApplication;
  let prisma: OutboxTestClient;
  let transactions: TransactionRunner;
  let enqueue: NotificationEnqueue;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [PrismaModule, NotificationsModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get<OutboxTestClient>(PrismaClientService);
    transactions = app.get(TransactionRunner);
    enqueue = app.get<NotificationEnqueue>(NOTIFICATION_ENQUEUE);
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM "Outbox"');
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects forged and expired transaction contexts', async () => {
    const notification = authNotification();

    await expect(
      enqueue.enqueue({} as TransactionContext, notification),
    ).rejects.toThrow('active TransactionContext');

    let expiredContext: TransactionContext | undefined;
    await transactions.run((context) => {
      expiredContext = context;
      return Promise.resolve();
    });

    await expect(
      enqueue.enqueue(expiredContext as TransactionContext, notification),
    ).rejects.toThrow('active TransactionContext');
    await expect(
      prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        'SELECT COUNT(*)::bigint AS count FROM "Outbox"',
      ),
    ).resolves.toEqual([{ count: 0n }]);
  });

  it('stores only identifier payload and encrypted expiring verification material', async () => {
    const notification = authNotification();

    await expect(
      transactions.run((context) => enqueue.enqueue(context, notification)),
    ).resolves.toEqual({ eventId: notification.eventId });

    const rows = await prisma.$queryRawUnsafe<StoredOutboxRow[]>(
      `SELECT "eventId", "businessIdempotencyKey", "kind", "aggregateType",
              "aggregateId", "payload", "secretCiphertext", "secretExpiresAt",
              "state", "attempts", "maxAttempts"
         FROM "Outbox"`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventId: notification.eventId,
      businessIdempotencyKey: `auth:verify:${notification.tokenRecordId}`,
      kind: 'AUTH_EMAIL_VERIFICATION',
      aggregateType: 'User',
      aggregateId: notification.userId,
      secretExpiresAt: notification.secretExpiresAt,
      state: 'READY',
      attempts: 0,
      maxAttempts: 10,
    });
    expect(rows[0]?.payload).toEqual({
      tokenRecordId: notification.tokenRecordId,
    });
    expect(rows[0]?.secretCiphertext).toEqual(
      Buffer.from(notification.secretCiphertext),
    );
  });

  it('derives a distinct password-reset business idempotency key', async () => {
    const notification = authNotification({ kind: 'AUTH_PASSWORD_RESET' });

    await transactions.run((context) => enqueue.enqueue(context, notification));

    await expect(
      prisma.$queryRawUnsafe<Array<{ businessIdempotencyKey: string }>>(
        `SELECT "businessIdempotencyKey" FROM "Outbox"`,
      ),
    ).resolves.toEqual([
      {
        businessIdempotencyKey: `auth:reset:${notification.tokenRecordId}`,
      },
    ]);
  });

  it('rolls back enqueue with the caller transaction', async () => {
    const notification = authNotification();

    await expect(
      transactions.run(async (context) => {
        await enqueue.enqueue(context, notification);
        throw new Error('auth rollback');
      }),
    ).rejects.toThrow('auth rollback');

    await expect(
      prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        'SELECT COUNT(*)::bigint AS count FROM "Outbox"',
      ),
    ).resolves.toEqual([{ count: 0n }]);
  });

  it('rejects duplicate auth token delivery without a second row', async () => {
    const first = authNotification();
    const duplicate = authNotification({
      tokenRecordId: first.tokenRecordId,
      kind: first.kind,
    });

    await transactions.run((context) => enqueue.enqueue(context, first));
    await expect(
      transactions.run((context) => enqueue.enqueue(context, duplicate)),
    ).rejects.toThrow();

    await expect(
      prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        'SELECT COUNT(*)::bigint AS count FROM "Outbox"',
      ),
    ).resolves.toEqual([{ count: 1n }]);
  });

  it('rejects invalid identifiers, empty ciphertext, and expired material before writing', async () => {
    const invalidNotifications: AuthNotification[] = [
      authNotification({ userId: 'owner@example.test' }),
      authNotification({ tokenRecordId: '+79990000000' }),
      authNotification({ secretCiphertext: new Uint8Array() }),
      authNotification({ secretExpiresAt: new Date(Date.now() - 1) }),
    ];

    for (const notification of invalidNotifications) {
      await expect(
        transactions.run((context) => enqueue.enqueue(context, notification)),
      ).rejects.toThrow();
    }

    await expect(
      prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        'SELECT COUNT(*)::bigint AS count FROM "Outbox"',
      ),
    ).resolves.toEqual([{ count: 0n }]);
  });
});
