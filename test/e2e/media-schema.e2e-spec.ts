import { randomUUID } from 'node:crypto';
import { DatabaseError, Pool, type PoolClient } from 'pg';

interface ColumnContract {
  readonly columnName: string;
  readonly dataType: string;
  readonly columnDefault: string | null;
  readonly isNullable: 'YES' | 'NO';
}

async function columns(
  client: PoolClient,
  tableName: string,
): Promise<ColumnContract[]> {
  const result = await client.query<{
    column_default: string | null;
    column_name: string;
    data_type: string;
    is_nullable: 'YES' | 'NO';
  }>(
    `SELECT column_name, data_type, column_default, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [tableName],
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

async function constraintDefinitions(
  client: PoolClient,
  tableName: string,
): Promise<string[]> {
  const result = await client.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(constraint_row.oid) AS definition
       FROM pg_constraint AS constraint_row
       JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public' AND relation.relname = $1
      ORDER BY constraint_row.conname`,
    [tableName],
  );
  return result.rows.map(({ definition }) => definition);
}

async function indexDefinitions(
  client: PoolClient,
  tableName: string,
): Promise<string[]> {
  const result = await client.query<{ indexdef: string }>(
    `SELECT indexdef
       FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = $1
      ORDER BY indexname`,
    [tableName],
  );
  return result.rows.map(({ indexdef }) => indexdef);
}

async function expectConstraintViolation(
  client: PoolClient,
  statement: string,
  values: readonly unknown[],
): Promise<void> {
  const savepoint = `constraint_${randomUUID().replaceAll('-', '')}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    let rejection: unknown;
    try {
      await client.query(statement, [...values]);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(DatabaseError);
    if (!(rejection instanceof DatabaseError)) {
      throw new Error(
        'Expected PostgreSQL to reject a schema constraint violation',
      );
    }
    expect(rejection.code).toMatch(/^23/u);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
}

async function insertWorkspace(client: PoolClient): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO "Workspace" ("id", "name", "createdAt", "updatedAt")
     VALUES ($1, 'Media workspace', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id],
  );
  return id;
}

async function insertProject(
  client: PoolClient,
  workspaceId: string,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO "Project"
       ("id", "workspaceId", "createOperationId", "name", "publicSlug",
        "draft", "draftSchemaVersion", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'Media project', $4, '{"schemaVersion":4}'::jsonb,
             4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, workspaceId, randomUUID(), `media-${randomUUID()}`],
  );
  return id;
}

async function insertImportBatch(
  client: PoolClient,
  workspaceId: string,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO "MediaImportBatch" ("id", "workspaceId", "expiresAt")
     VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '24 hours')`,
    [id, workspaceId],
  );
  return id;
}

function pendingAssetValues(input: {
  readonly workspaceId: string;
  readonly projectId: string | null;
  readonly importBatchId: string | null;
}): readonly unknown[] {
  return [
    randomUUID(),
    input.workspaceId,
    input.projectId,
    input.importBatchId,
    `workspaces/${input.workspaceId}/asset.webp`,
    'asset.webp',
    'image/webp',
    4,
    'a'.repeat(64),
  ];
}

const insertPendingAsset = `INSERT INTO "MediaAsset"
  ("id", "workspaceId", "projectId", "importBatchId", "objectKey",
   "declaredFileName", "declaredMimeType", "declaredSizeBytes",
   "declaredChecksumSha256")
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

describe('managed media persistence schema', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
    client = await pool.connect();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  it('creates the exact media status enum and owned tables', async () => {
    const enumResult = await client.query<{ enumlabel: string }>(
      `SELECT enum_value.enumlabel
         FROM pg_type AS enum_type
         JOIN pg_enum AS enum_value ON enum_value.enumtypid = enum_type.oid
        WHERE enum_type.typname = 'MediaAssetStatus'
        ORDER BY enum_value.enumsortorder`,
    );
    expect(enumResult.rows.map(({ enumlabel }) => enumlabel)).toEqual([
      'PENDING',
      'READY',
      'DELETING',
    ]);

    await expect(columns(client, 'MediaImportBatch')).resolves.toEqual([
      {
        columnName: 'id',
        dataType: 'uuid',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'workspaceId',
        dataType: 'uuid',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'attachedProjectId',
        dataType: 'uuid',
        columnDefault: null,
        isNullable: 'YES',
      },
      {
        columnName: 'expiresAt',
        dataType: 'timestamp without time zone',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'attachedAt',
        dataType: 'timestamp without time zone',
        columnDefault: null,
        isNullable: 'YES',
      },
      {
        columnName: 'createdAt',
        dataType: 'timestamp without time zone',
        columnDefault: 'CURRENT_TIMESTAMP',
        isNullable: 'NO',
      },
    ]);

    await expect(columns(client, 'MediaAsset')).resolves.toEqual([
      {
        columnName: 'id',
        dataType: 'uuid',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'workspaceId',
        dataType: 'uuid',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'projectId',
        dataType: 'uuid',
        columnDefault: null,
        isNullable: 'YES',
      },
      {
        columnName: 'importBatchId',
        dataType: 'uuid',
        columnDefault: null,
        isNullable: 'YES',
      },
      {
        columnName: 'status',
        dataType: 'USER-DEFINED',
        columnDefault: `'PENDING'::"MediaAssetStatus"`,
        isNullable: 'NO',
      },
      {
        columnName: 'objectKey',
        dataType: 'character varying',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'declaredFileName',
        dataType: 'character varying',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'declaredMimeType',
        dataType: 'character varying',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'declaredSizeBytes',
        dataType: 'integer',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'declaredChecksumSha256',
        dataType: 'character varying',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'verifiedMimeType',
        dataType: 'character varying',
        columnDefault: null,
        isNullable: 'YES',
      },
      {
        columnName: 'verifiedSizeBytes',
        dataType: 'integer',
        columnDefault: null,
        isNullable: 'YES',
      },
      {
        columnName: 'verifiedWidth',
        dataType: 'integer',
        columnDefault: null,
        isNullable: 'YES',
      },
      {
        columnName: 'verifiedHeight',
        dataType: 'integer',
        columnDefault: null,
        isNullable: 'YES',
      },
      {
        columnName: 'verifiedChecksumSha256',
        dataType: 'character varying',
        columnDefault: null,
        isNullable: 'YES',
      },
      {
        columnName: 'verifiedAt',
        dataType: 'timestamp without time zone',
        columnDefault: null,
        isNullable: 'YES',
      },
      {
        columnName: 'deletionMarkedAt',
        dataType: 'timestamp without time zone',
        columnDefault: null,
        isNullable: 'YES',
      },
      {
        columnName: 'createdAt',
        dataType: 'timestamp without time zone',
        columnDefault: 'CURRENT_TIMESTAMP',
        isNullable: 'NO',
      },
      {
        columnName: 'updatedAt',
        dataType: 'timestamp without time zone',
        columnDefault: null,
        isNullable: 'NO',
      },
    ]);
  });

  it('enforces tenant-safe restrictive ownership and exact indexes', async () => {
    const batchConstraints = (
      await constraintDefinitions(client, 'MediaImportBatch')
    ).join('\n');
    expect(batchConstraints).toMatch(
      /FOREIGN KEY \("workspaceId"\) REFERENCES "Workspace"\(id\).+ON DELETE RESTRICT/u,
    );
    expect(batchConstraints).toMatch(
      /FOREIGN KEY \("workspaceId", "attachedProjectId"\) REFERENCES "Project"\("workspaceId", id\).+ON DELETE RESTRICT/u,
    );
    expect(batchConstraints).toMatch(
      /CHECK .+"attachedAt" IS NULL.+"attachedProjectId" IS NULL/u,
    );
    expect(batchConstraints).toMatch(
      /CHECK .+"expiresAt" = .+"createdAt".+24:00:00/u,
    );

    const assetConstraints = (
      await constraintDefinitions(client, 'MediaAsset')
    ).join('\n');
    expect(assetConstraints).toMatch(
      /FOREIGN KEY \("workspaceId", "projectId"\) REFERENCES "Project"\("workspaceId", id\).+ON DELETE RESTRICT/u,
    );
    expect(assetConstraints).toMatch(
      /FOREIGN KEY \("workspaceId", "importBatchId"\) REFERENCES "MediaImportBatch"\("workspaceId", id\).+ON DELETE RESTRICT/u,
    );
    expect(assetConstraints).toMatch(
      /FOREIGN KEY \("workspaceId"\) REFERENCES "Workspace"\(id\).+ON DELETE RESTRICT/u,
    );

    expect(await indexDefinitions(client, 'MediaImportBatch')).toHaveLength(4);
    expect(await indexDefinitions(client, 'MediaAsset')).toHaveLength(6);
    expect(await indexDefinitions(client, 'Project')).toHaveLength(5);
  });

  it('rejects cross-tenant ownership and ownerless assets', async () => {
    const workspaceId = await insertWorkspace(client);
    const projectId = await insertProject(client, workspaceId);
    const otherWorkspaceId = await insertWorkspace(client);
    const otherBatchId = await insertImportBatch(client, otherWorkspaceId);

    await expectConstraintViolation(
      client,
      `INSERT INTO "MediaImportBatch"
        ("id", "workspaceId", "createdAt", "expiresAt")
       VALUES ($1, $2, CURRENT_TIMESTAMP,
               CURRENT_TIMESTAMP + INTERVAL '25 hours')`,
      [randomUUID(), workspaceId],
    );

    await expectConstraintViolation(
      client,
      insertPendingAsset,
      pendingAssetValues({
        workspaceId,
        projectId: null,
        importBatchId: null,
      }),
    );
    await expectConstraintViolation(
      client,
      insertPendingAsset,
      pendingAssetValues({
        workspaceId: otherWorkspaceId,
        projectId,
        importBatchId: null,
      }),
    );
    await expectConstraintViolation(
      client,
      insertPendingAsset,
      pendingAssetValues({
        workspaceId,
        projectId: null,
        importBatchId: otherBatchId,
      }),
    );
  });

  it('enforces declaration, verification, dimension, and deletion state invariants', async () => {
    const workspaceId = await insertWorkspace(client);
    const projectId = await insertProject(client, workspaceId);
    const pendingValues = pendingAssetValues({
      workspaceId,
      projectId,
      importBatchId: null,
    });

    await expectConstraintViolation(client, insertPendingAsset, [
      ...pendingValues.slice(0, 6),
      'image/gif',
      ...pendingValues.slice(7),
    ]);
    await expectConstraintViolation(
      client,
      `INSERT INTO "MediaAsset"
        ("id", "workspaceId", "projectId", "status", "objectKey",
         "declaredFileName", "declaredMimeType", "declaredSizeBytes",
         "declaredChecksumSha256")
       VALUES ($1, $2, $3, 'READY', $4, 'asset.webp', 'image/webp', 4, $5)`,
      [
        randomUUID(),
        workspaceId,
        projectId,
        `workspaces/${workspaceId}/ready.webp`,
        'a'.repeat(64),
      ],
    );
    await expectConstraintViolation(
      client,
      `INSERT INTO "MediaAsset"
        ("id", "workspaceId", "projectId", "status", "objectKey",
         "declaredFileName", "declaredMimeType", "declaredSizeBytes",
         "declaredChecksumSha256", "verifiedMimeType", "verifiedSizeBytes",
         "verifiedWidth", "verifiedHeight", "verifiedChecksumSha256",
         "verifiedAt")
       VALUES ($1, $2, $3, 'READY', $4, 'asset.webp', 'image/webp', 4, $5,
               'image/webp', 4, 12000, 12000, $5, CURRENT_TIMESTAMP)`,
      [
        randomUUID(),
        workspaceId,
        projectId,
        `workspaces/${workspaceId}/oversized.webp`,
        'a'.repeat(64),
      ],
    );
    await expectConstraintViolation(
      client,
      `INSERT INTO "MediaAsset"
        ("id", "workspaceId", "projectId", "status", "objectKey",
         "declaredFileName", "declaredMimeType", "declaredSizeBytes",
         "declaredChecksumSha256", "verifiedMimeType", "verifiedSizeBytes",
         "verifiedWidth", "verifiedHeight", "verifiedChecksumSha256",
         "verifiedAt")
       VALUES ($1, $2, $3, 'DELETING', $4, 'asset.webp', 'image/webp', 4, $5,
               'image/webp', 4, 1, 1, $5, CURRENT_TIMESTAMP)`,
      [
        randomUUID(),
        workspaceId,
        projectId,
        `workspaces/${workspaceId}/deleting.webp`,
        'a'.repeat(64),
      ],
    );
  });
});
