import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  IDEMPOTENCY_STORE,
  type IdempotencyRecordStore,
  type NewIdempotencyRecord,
  versionedRequestFingerprint,
} from '../../src/shared/idempotency/idempotency-store';
import { PrismaModule } from '../../src/shared/database/prisma.module';
import { PrismaClientService } from '../../src/shared/database/prisma.service';
import {
  TransactionRunner,
  type TransactionContext,
} from '../../src/shared/database/transaction-runner';

interface IdempotencyTestClient {
  $executeRawUnsafe(
    statement: string,
    ...values: readonly unknown[]
  ): Promise<number>;
  $queryRawUnsafe<T>(
    statement: string,
    ...values: readonly unknown[]
  ): Promise<T>;
}

interface StoredIdempotencyRow {
  readonly completedAt: Date;
  readonly createdAt: Date;
  readonly httpStatus: number;
  readonly key: string;
  readonly operation: string;
  readonly requestFingerprint: string;
  readonly resourceId: string | null;
  readonly responseBody: unknown;
  readonly scope: string;
}

function idempotencyRecord(
  overrides: Partial<NewIdempotencyRecord> = {},
): NewIdempotencyRecord {
  const projectId = randomUUID();
  return {
    scope: `test:p104:workspace:${randomUUID()}`,
    operation: 'CREATE_PROJECT',
    key: randomUUID(),
    requestFingerprint: versionedRequestFingerprint(
      `hmac-sha256:v1:${'a'.repeat(64)}`,
    ),
    httpStatus: 201,
    responseBody: {
      id: projectId,
      publicSlug: `project-${projectId}`,
      draftVersion: 1,
      status: 'created',
    },
    resourceId: projectId,
    ...overrides,
  };
}

async function countRecord(
  prisma: IdempotencyTestClient,
  record: NewIdempotencyRecord,
): Promise<bigint> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count
       FROM "IdempotencyRecord"
      WHERE "scope" = $1 AND "operation" = $2 AND "key" = $3`,
    record.scope,
    record.operation,
    record.key,
  );
  return rows[0]?.count ?? -1n;
}

async function insertRawRecord(
  prisma: IdempotencyTestClient,
  record: NewIdempotencyRecord,
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "IdempotencyRecord"
       ("scope", "operation", "key", "requestFingerprint", "httpStatus",
        "responseBody", "resourceId")
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    record.scope,
    record.operation,
    record.key,
    record.requestFingerprint,
    record.httpStatus,
    JSON.stringify(record.responseBody),
    record.resourceId,
  );
}

describe('transaction-aware Prisma idempotency persistence adapter', () => {
  let app: INestApplication;
  let prisma: IdempotencyTestClient;
  let transactions: TransactionRunner;
  let store: IdempotencyRecordStore;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get<IdempotencyTestClient>(PrismaClientService);
    transactions = app.get(TransactionRunner);
    store = app.get<IdempotencyRecordStore>(IDEMPOTENCY_STORE);
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects forged and expired transaction contexts', async () => {
    const record = idempotencyRecord();

    await expect(store.read({} as TransactionContext, record)).rejects.toThrow(
      'active TransactionContext',
    );
    await expect(
      store.create({} as TransactionContext, record),
    ).rejects.toThrow('active TransactionContext');
    await expect(
      store.clearResourceId(
        {} as TransactionContext,
        record.resourceId as string,
      ),
    ).rejects.toThrow('active TransactionContext');

    let expiredContext: TransactionContext | undefined;
    await transactions.run((context) => {
      expiredContext = context;
      return Promise.resolve();
    });

    await expect(
      store.read(expiredContext as TransactionContext, record),
    ).rejects.toThrow('active TransactionContext');
    await expect(
      store.create(expiredContext as TransactionContext, record),
    ).rejects.toThrow('active TransactionContext');
    await expect(
      store.clearResourceId(
        expiredContext as TransactionContext,
        record.resourceId as string,
      ),
    ).rejects.toThrow('active TransactionContext');
    await expect(countRecord(prisma, record)).resolves.toBe(0n);
  });

  it('commits an allowlisted record and reads it through a later active transaction', async () => {
    const record = idempotencyRecord();

    const created = await transactions.run((context) =>
      store.create(context, record),
    );
    expect(created).toMatchObject(record);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.completedAt).toBeInstanceOf(Date);

    await expect(
      transactions.run((context) => store.read(context, record)),
    ).resolves.toMatchObject(record);

    const rows = await prisma.$queryRawUnsafe<StoredIdempotencyRow[]>(
      `SELECT "scope", "operation", "key", "requestFingerprint", "httpStatus",
              "responseBody", "resourceId", "createdAt", "completedAt"
         FROM "IdempotencyRecord"
        WHERE "scope" = $1 AND "operation" = $2 AND "key" = $3`,
      record.scope,
      record.operation,
      record.key,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(record);
    expect(rows[0]?.responseBody).toEqual(record.responseBody);
  });

  it('returns null when the scoped operation key has no record', async () => {
    const record = idempotencyRecord();

    await expect(
      transactions.run((context) => store.read(context, record)),
    ).resolves.toBeNull();
  });

  it('rolls back the record with its caller transaction', async () => {
    const record = idempotencyRecord();

    await expect(
      transactions.run(async (context) => {
        await store.create(context, record);
        throw new Error('business rollback');
      }),
    ).rejects.toThrow('business rollback');

    await expect(countRecord(prisma, record)).resolves.toBe(0n);
  });

  it('rejects response bodies outside the storage allowlist before writing', async () => {
    const unsafeRecords = [
      {
        ...idempotencyRecord(),
        responseBody: { siteConfig: { pages: [] } },
      },
      {
        ...idempotencyRecord(),
        responseBody: {
          code: 'PROJECT_VERSION_CONFLICT',
          draftVersion: '2',
        },
      },
    ] as unknown as NewIdempotencyRecord[];

    for (const record of unsafeRecords) {
      await expect(
        transactions.run((context) => store.create(context, record)),
      ).rejects.toThrow('responseBody is not allowlisted');
      await expect(countRecord(prisma, record)).resolves.toBe(0n);
    }
  });

  it('rejects an unversioned request fingerprint before writing', async () => {
    const record = idempotencyRecord({
      requestFingerprint:
        `${'b'.repeat(64)}` as NewIdempotencyRecord['requestFingerprint'],
    });

    await expect(
      transactions.run((context) => store.create(context, record)),
    ).rejects.toThrow('requestFingerprint is not versioned');
    await expect(countRecord(prisma, record)).resolves.toBe(0n);
  });

  it('rejects a stored response body outside the allowlist before returning it', async () => {
    const record = idempotencyRecord({
      responseBody: { id: randomUUID() },
    });
    const unsafeRecord = {
      ...record,
      responseBody: { siteConfig: { pages: [] } },
    } as unknown as NewIdempotencyRecord;
    await insertRawRecord(prisma, unsafeRecord);

    await expect(
      transactions.run((context) => store.read(context, record)),
    ).rejects.toThrow('responseBody is not allowlisted');
  });

  it('rejects a stored unversioned request fingerprint before returning it', async () => {
    const record = idempotencyRecord({
      requestFingerprint:
        `v1:${'c'.repeat(64)}` as NewIdempotencyRecord['requestFingerprint'],
    });
    await insertRawRecord(prisma, record);

    await expect(
      transactions.run((context) => store.read(context, record)),
    ).rejects.toThrow('requestFingerprint is not versioned');
  });

  it('clears a deleted resource reference without removing replay identity', async () => {
    const record = idempotencyRecord();
    await transactions.run((context) => store.create(context, record));

    await expect(
      transactions.run((context) =>
        store.clearResourceId(context, record.resourceId as string),
      ),
    ).resolves.toBe(1);

    const stored = await transactions.run((context) =>
      store.read(context, record),
    );
    expect(stored).toMatchObject({
      ...record,
      resourceId: null,
    });
  });
});
