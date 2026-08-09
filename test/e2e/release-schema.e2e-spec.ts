import { randomUUID } from 'node:crypto';
import { DatabaseError, Pool, type PoolClient } from 'pg';

interface ColumnContract {
  readonly columnName: string;
  readonly dataType: string;
  readonly datetimePrecision: number | null;
  readonly columnDefault: string | null;
  readonly isNullable: 'YES' | 'NO';
}

interface ReleaseFixture {
  readonly id: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly siteConfig: Readonly<Record<string, unknown>>;
  readonly version: number;
}

async function columns(
  client: PoolClient,
  tableName: string,
): Promise<ColumnContract[]> {
  const result = await client.query<{
    column_default: string | null;
    column_name: string;
    data_type: string;
    datetime_precision: number | null;
    is_nullable: 'YES' | 'NO';
  }>(
    `SELECT column_name, data_type, datetime_precision, column_default,
            is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [tableName],
  );
  return result.rows.map(
    ({
      column_default,
      column_name,
      data_type,
      datetime_precision,
      is_nullable,
    }) => ({
      columnName: column_name,
      dataType: data_type,
      datetimePrecision: datetime_precision,
      columnDefault: column_default,
      isNullable: is_nullable,
    }),
  );
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

async function foreignKeyDefinitions(
  client: PoolClient,
  tableName: string,
): Promise<string[]> {
  const result = await client.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(foreign_key.oid) AS definition
       FROM pg_constraint AS foreign_key
       JOIN pg_class AS relation ON relation.oid = foreign_key.conrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = $1
        AND foreign_key.contype = 'f'
      ORDER BY foreign_key.conname`,
    [tableName],
  );
  return result.rows.map(({ definition }) => definition);
}

async function primaryKeyColumns(
  client: PoolClient,
  tableName: string,
): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `SELECT key_usage.column_name
       FROM information_schema.table_constraints AS constraints
       JOIN information_schema.key_column_usage AS key_usage
         ON key_usage.constraint_schema = constraints.constraint_schema
        AND key_usage.constraint_name = constraints.constraint_name
        AND key_usage.table_name = constraints.table_name
      WHERE constraints.constraint_schema = 'public'
        AND constraints.table_name = $1
        AND constraints.constraint_type = 'PRIMARY KEY'
      ORDER BY key_usage.ordinal_position`,
    [tableName],
  );
  return result.rows.map(({ column_name }) => column_name);
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
  const workspaceId = randomUUID();
  await client.query(
    `INSERT INTO "Workspace" ("id", "name", "createdAt", "updatedAt")
     VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [workspaceId, 'Release schema workspace'],
  );
  return workspaceId;
}

async function insertProject(client: PoolClient): Promise<string> {
  const projectId = randomUUID();
  await client.query(
    `INSERT INTO "Project"
       ("id", "workspaceId", "createOperationId", "name", "publicSlug",
        "draft", "draftSchemaVersion", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 4,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      projectId,
      await insertWorkspace(client),
      randomUUID(),
      'Release project',
      `release-${randomUUID()}`,
      JSON.stringify({ schemaVersion: 4, pages: [] }),
    ],
  );
  return projectId;
}

async function insertRelease(
  client: PoolClient,
  projectId: string,
  overrides: Partial<ReleaseFixture> = {},
): Promise<ReleaseFixture> {
  const release: ReleaseFixture = {
    id: randomUUID(),
    operationId: randomUUID(),
    projectId,
    siteConfig: { schemaVersion: 4, pages: [] },
    version: 1,
    ...overrides,
  };
  await client.query(
    `INSERT INTO "Release"
       ("id", "projectId", "operationId", "version", "siteConfig",
        "schemaVersion")
     VALUES ($1, $2, $3, $4, $5::jsonb, 4)`,
    [
      release.id,
      release.projectId,
      release.operationId,
      release.version,
      JSON.stringify(release.siteConfig),
    ],
  );
  return release;
}

describe('release and active release persistence schema', () => {
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

  it('creates the exact Release and ActiveRelease columns without a Project activation column', async () => {
    await expect(columns(client, 'Release')).resolves.toEqual([
      {
        columnName: 'id',
        dataType: 'uuid',
        datetimePrecision: null,
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'projectId',
        dataType: 'uuid',
        datetimePrecision: null,
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'operationId',
        dataType: 'text',
        datetimePrecision: null,
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'version',
        dataType: 'integer',
        datetimePrecision: null,
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'siteConfig',
        dataType: 'jsonb',
        datetimePrecision: null,
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'schemaVersion',
        dataType: 'integer',
        datetimePrecision: null,
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'publishedAt',
        dataType: 'timestamp without time zone',
        datetimePrecision: 3,
        columnDefault: 'CURRENT_TIMESTAMP',
        isNullable: 'NO',
      },
    ]);
    await expect(columns(client, 'ActiveRelease')).resolves.toEqual([
      {
        columnName: 'projectId',
        dataType: 'uuid',
        datetimePrecision: null,
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'releaseId',
        dataType: 'uuid',
        datetimePrecision: null,
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'activatedAt',
        dataType: 'timestamp without time zone',
        datetimePrecision: 3,
        columnDefault: 'CURRENT_TIMESTAMP',
        isNullable: 'NO',
      },
    ]);

    const projectColumns = await columns(client, 'Project');
    expect(projectColumns.map(({ columnName }) => columnName)).toEqual([
      'id',
      'workspaceId',
      'createOperationId',
      'name',
      'publicSlug',
      'draft',
      'draftSchemaVersion',
      'draftVersion',
      'createdAt',
      'updatedAt',
    ]);
  });

  it('defines exact release uniqueness and composite activation indexes', async () => {
    await expect(primaryKeyColumns(client, 'Release')).resolves.toEqual(['id']);
    await expect(primaryKeyColumns(client, 'ActiveRelease')).resolves.toEqual([
      'projectId',
    ]);

    const releaseIndexDefinitions = await indexDefinitions(client, 'Release');
    expect(releaseIndexDefinitions).toHaveLength(4);
    const releaseIndexes = releaseIndexDefinitions.join('\n');
    expect(releaseIndexes).toMatch(/UNIQUE.+\(id\)/u);
    expect(releaseIndexes).toMatch(/UNIQUE.+\("projectId", id\)/u);
    expect(releaseIndexes).toMatch(/UNIQUE.+\("projectId", version\)/u);
    expect(releaseIndexes).toMatch(/UNIQUE.+\("projectId", "operationId"\)/u);

    const activeIndexDefinitions = await indexDefinitions(
      client,
      'ActiveRelease',
    );
    expect(activeIndexDefinitions).toHaveLength(2);
    const activeIndexes = activeIndexDefinitions.join('\n');
    expect(activeIndexes).toMatch(/UNIQUE.+\("projectId"\)/u);
    expect(
      activeIndexDefinitions.filter((definition) =>
        definition.endsWith('("releaseId")'),
      ),
    ).toEqual([expect.stringMatching(/^CREATE INDEX /u)]);
  });

  it('uses restrictive release ownership and cascading composite activation foreign keys', async () => {
    await expect(foreignKeyDefinitions(client, 'Release')).resolves.toEqual([
      expect.stringMatching(
        /FOREIGN KEY \("projectId"\) REFERENCES "Project"\(id\) ON UPDATE CASCADE ON DELETE RESTRICT/u,
      ),
    ]);
    const activeForeignKeys = await foreignKeyDefinitions(
      client,
      'ActiveRelease',
    );
    expect(activeForeignKeys).toHaveLength(2);
    expect(activeForeignKeys).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /FOREIGN KEY \("projectId"\) REFERENCES "Project"\(id\) ON UPDATE CASCADE ON DELETE CASCADE/u,
        ),
        expect.stringMatching(
          /FOREIGN KEY \("projectId", "releaseId"\) REFERENCES "Release"\("projectId", id\) ON UPDATE CASCADE ON DELETE CASCADE/u,
        ),
      ]),
    );
  });

  it('rejects cross-project activation through the composite release relationship', async () => {
    const releaseProjectId = await insertProject(client);
    const otherProjectId = await insertProject(client);
    const release = await insertRelease(client, releaseProjectId);

    await expectConstraintViolation(
      client,
      `INSERT INTO "ActiveRelease" ("projectId", "releaseId")
       VALUES ($1, $2)`,
      [otherProjectId, release.id],
    );
    await expect(
      client.query(
        `INSERT INTO "ActiveRelease" ("projectId", "releaseId")
         VALUES ($1, $2)`,
        [releaseProjectId, release.id],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it('enforces release version and operation uniqueness per project only', async () => {
    const firstProjectId = await insertProject(client);
    const secondProjectId = await insertProject(client);
    const first = await insertRelease(client, firstProjectId);

    await expectConstraintViolation(
      client,
      `INSERT INTO "Release"
         ("id", "projectId", "operationId", "version", "siteConfig",
          "schemaVersion")
       VALUES ($1, $2, $3, $4, '{}'::jsonb, 4)`,
      [randomUUID(), firstProjectId, randomUUID(), first.version],
    );
    await expectConstraintViolation(
      client,
      `INSERT INTO "Release"
         ("id", "projectId", "operationId", "version", "siteConfig",
          "schemaVersion")
       VALUES ($1, $2, $3, $4, '{}'::jsonb, 4)`,
      [randomUUID(), firstProjectId, first.operationId, first.version + 1],
    );
    await expect(
      insertRelease(client, secondProjectId, {
        operationId: first.operationId,
        version: first.version,
      }),
    ).resolves.toMatchObject({ projectId: secondProjectId });
  });

  it('rolls back by moving only the activation pointer and preserving immutable releases', async () => {
    const projectId = await insertProject(client);
    const first = await insertRelease(client, projectId, {
      siteConfig: { schemaVersion: 4, marker: 'first' },
      version: 1,
    });
    const second = await insertRelease(client, projectId, {
      siteConfig: { schemaVersion: 4, marker: 'second' },
      version: 2,
    });
    await client.query(
      `INSERT INTO "ActiveRelease" ("projectId", "releaseId")
       VALUES ($1, $2)`,
      [projectId, second.id],
    );
    const before = await client.query(
      `SELECT * FROM "Release" WHERE "projectId" = $1 ORDER BY "version"`,
      [projectId],
    );

    await client.query(
      `UPDATE "ActiveRelease"
          SET "releaseId" = $2, "activatedAt" = CURRENT_TIMESTAMP
        WHERE "projectId" = $1`,
      [projectId, first.id],
    );

    await expect(
      client.query<{ releaseId: string }>(
        `SELECT "releaseId" FROM "ActiveRelease" WHERE "projectId" = $1`,
        [projectId],
      ),
    ).resolves.toMatchObject({ rows: [{ releaseId: first.id }] });
    await expect(
      client.query(
        `SELECT * FROM "Release" WHERE "projectId" = $1 ORDER BY "version"`,
        [projectId],
      ),
    ).resolves.toMatchObject({ rows: before.rows });
  });

  it('restricts project deletion and removes its activation when the selected release is deleted', async () => {
    const projectId = await insertProject(client);
    const release = await insertRelease(client, projectId);
    await client.query(
      `INSERT INTO "ActiveRelease" ("projectId", "releaseId")
       VALUES ($1, $2)`,
      [projectId, release.id],
    );

    await expectConstraintViolation(
      client,
      `DELETE FROM "Project" WHERE "id" = $1`,
      [projectId],
    );
    await client.query(`DELETE FROM "Release" WHERE "id" = $1`, [release.id]);
    await expect(
      client.query<{ count: string }>(
        `SELECT COUNT(*) AS count
           FROM "ActiveRelease"
          WHERE "projectId" = $1`,
        [projectId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: '0' }] });
    await expect(
      client.query(`DELETE FROM "Project" WHERE "id" = $1`, [projectId]),
    ).resolves.toMatchObject({ rowCount: 1 });
  });
});
