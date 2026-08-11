import { randomUUID } from 'node:crypto';
import { DatabaseError, Pool, type PoolClient } from 'pg';

interface ColumnContract {
  readonly columnName: string;
  readonly dataType: string;
  readonly columnDefault: string | null;
  readonly isNullable: 'YES' | 'NO';
}

interface ForeignKeyContract {
  readonly columnName: string;
  readonly deleteRule: string;
  readonly foreignTableName: string;
}

const SITE_TABLES = [
  'Project',
  'ProjectRevision',
  'IdempotencyRecord',
] as const;

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

async function foreignKeys(
  client: PoolClient,
  tableName: string,
): Promise<ForeignKeyContract[]> {
  const result = await client.query<{
    column_name: string;
    delete_rule: string;
    foreign_table_name: string;
  }>(
    `SELECT key_usage.column_name,
            referential.delete_rule,
            constraint_usage.table_name AS foreign_table_name
       FROM information_schema.referential_constraints AS referential
       JOIN information_schema.key_column_usage AS key_usage
         ON key_usage.constraint_schema = referential.constraint_schema
        AND key_usage.constraint_name = referential.constraint_name
       JOIN information_schema.constraint_column_usage AS constraint_usage
         ON constraint_usage.constraint_schema = referential.unique_constraint_schema
        AND constraint_usage.constraint_name = referential.unique_constraint_name
      WHERE referential.constraint_schema = 'public'
        AND key_usage.table_name = $1
      ORDER BY key_usage.column_name`,
    [tableName],
  );
  return result.rows.map(
    ({ column_name, delete_rule, foreign_table_name }) => ({
      columnName: column_name,
      deleteRule: delete_rule,
      foreignTableName: foreign_table_name,
    }),
  );
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

interface ProjectFixture {
  readonly createOperationId: string;
  readonly id: string;
  readonly publicSlug: string;
  readonly workspaceId: string;
}

async function insertWorkspace(client: PoolClient): Promise<string> {
  const workspaceId = randomUUID();
  await client.query(
    `INSERT INTO "Workspace" ("id", "name", "createdAt", "updatedAt")
     VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [workspaceId, 'Sites schema workspace'],
  );
  return workspaceId;
}

async function insertProject(
  client: PoolClient,
  overrides: Partial<ProjectFixture> = {},
): Promise<ProjectFixture> {
  const project = {
    id: randomUUID(),
    workspaceId: await insertWorkspace(client),
    createOperationId: randomUUID(),
    publicSlug: `project-${randomUUID()}`,
    ...overrides,
  };
  await client.query(
    `INSERT INTO "Project"
       ("id", "workspaceId", "createOperationId", "name", "publicSlug",
        "draft", "draftSchemaVersion", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 4,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      project.id,
      project.workspaceId,
      project.createOperationId,
      'Draft project',
      project.publicSlug,
      JSON.stringify({ schemaVersion: 4, pages: [] }),
    ],
  );
  return project;
}

describe('sites draft persistence schema', () => {
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

  it('creates only the exact Project, ProjectRevision, and IdempotencyRecord columns', async () => {
    const tableResult = await client.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [SITE_TABLES],
    );
    expect(tableResult.rows.map(({ table_name }) => table_name)).toEqual(
      [...SITE_TABLES].sort(),
    );

    await expect(columns(client, 'Project')).resolves.toEqual([
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
        columnName: 'createOperationId',
        dataType: 'text',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'name',
        dataType: 'text',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'publicSlug',
        dataType: 'text',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'draft',
        dataType: 'jsonb',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'draftSchemaVersion',
        dataType: 'integer',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'draftVersion',
        dataType: 'integer',
        columnDefault: '1',
        isNullable: 'NO',
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

    await expect(columns(client, 'ProjectRevision')).resolves.toEqual([
      {
        columnName: 'id',
        dataType: 'uuid',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'projectId',
        dataType: 'uuid',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'operationId',
        dataType: 'text',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'version',
        dataType: 'integer',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'siteConfig',
        dataType: 'jsonb',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'schemaVersion',
        dataType: 'integer',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'createdAt',
        dataType: 'timestamp without time zone',
        columnDefault: 'CURRENT_TIMESTAMP',
        isNullable: 'NO',
      },
    ]);

    await expect(columns(client, 'IdempotencyRecord')).resolves.toEqual([
      {
        columnName: 'scope',
        dataType: 'text',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'operation',
        dataType: 'text',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'key',
        dataType: 'text',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'requestFingerprint',
        dataType: 'text',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'httpStatus',
        dataType: 'integer',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'responseBody',
        dataType: 'jsonb',
        columnDefault: null,
        isNullable: 'NO',
      },
      {
        columnName: 'resourceId',
        dataType: 'text',
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
        columnName: 'completedAt',
        dataType: 'timestamp without time zone',
        columnDefault: 'CURRENT_TIMESTAMP',
        isNullable: 'NO',
      },
    ]);
  });

  it('defines the exact primary, uniqueness, lookup, and workspace ordering indexes', async () => {
    await expect(primaryKeyColumns(client, 'Project')).resolves.toEqual(['id']);
    await expect(primaryKeyColumns(client, 'ProjectRevision')).resolves.toEqual(
      ['id'],
    );
    await expect(
      primaryKeyColumns(client, 'IdempotencyRecord'),
    ).resolves.toEqual(['scope', 'operation', 'key']);

    const projectIndexDefinitions = await indexDefinitions(client, 'Project');
    expect(projectIndexDefinitions).toHaveLength(5);
    const projectIndexes = projectIndexDefinitions.join('\n');
    expect(projectIndexes).toMatch(/UNIQUE.+\(id\)/u);
    expect(projectIndexes).toMatch(/UNIQUE.+\("publicSlug"\)/u);
    expect(projectIndexes).toMatch(
      /UNIQUE.+\("workspaceId", "createOperationId"\)/u,
    );
    expect(projectIndexes).toMatch(/UNIQUE.+\("workspaceId", id\)/u);
    expect(projectIndexes).toMatch(/\("workspaceId", "updatedAt"\)/u);

    const revisionIndexDefinitions = await indexDefinitions(
      client,
      'ProjectRevision',
    );
    expect(revisionIndexDefinitions).toHaveLength(3);
    const revisionIndexes = revisionIndexDefinitions.join('\n');
    expect(revisionIndexes).toMatch(/UNIQUE.+\(id\)/u);
    expect(revisionIndexes).toMatch(/UNIQUE.+\("projectId", version\)/u);
    expect(revisionIndexes).toMatch(/UNIQUE.+\("projectId", "operationId"\)/u);

    const idempotencyIndexDefinitions = await indexDefinitions(
      client,
      'IdempotencyRecord',
    );
    expect(idempotencyIndexDefinitions).toHaveLength(2);
    const idempotencyIndexes = idempotencyIndexDefinitions.join('\n');
    expect(idempotencyIndexes).toMatch(/UNIQUE.+\(scope, operation, key\)/u);
    expect(idempotencyIndexes).toMatch(/\("resourceId"\)/u);
  });

  it('defaults draftVersion to one and stores draft and revision siteConfig as JSONB', async () => {
    const project = await insertProject(client);
    const operationId = randomUUID();
    const siteConfig = { schemaVersion: 4, pages: [{ id: 'home' }] };

    await client.query(
      `INSERT INTO "ProjectRevision"
         ("id", "projectId", "operationId", "version", "siteConfig",
          "schemaVersion")
       VALUES ($1, $2, $3, 1, $4::jsonb, 4)`,
      [randomUUID(), project.id, operationId, JSON.stringify(siteConfig)],
    );

    const result = await client.query<{
      draft: unknown;
      draftVersion: number;
      siteConfig: unknown;
    }>(
      `SELECT project."draft", project."draftVersion", revision."siteConfig"
         FROM "Project" AS project
         JOIN "ProjectRevision" AS revision
           ON revision."projectId" = project."id"
        WHERE project."id" = $1`,
      [project.id],
    );
    expect(result.rows).toEqual([
      {
        draft: { schemaVersion: 4, pages: [] },
        draftVersion: 1,
        siteConfig,
      },
    ]);
  });

  it('restricts Project workspace deletion and cascades only Project revisions', async () => {
    const project = await insertProject(client);
    await client.query(
      `INSERT INTO "ProjectRevision"
         ("id", "projectId", "operationId", "version", "siteConfig",
          "schemaVersion")
       VALUES ($1, $2, $3, 1, $4::jsonb, 4)`,
      [randomUUID(), project.id, randomUUID(), JSON.stringify({ pages: [] })],
    );

    await expect(foreignKeys(client, 'Project')).resolves.toEqual([
      {
        columnName: 'workspaceId',
        deleteRule: 'RESTRICT',
        foreignTableName: 'Workspace',
      },
    ]);
    await expect(foreignKeys(client, 'ProjectRevision')).resolves.toEqual([
      {
        columnName: 'projectId',
        deleteRule: 'CASCADE',
        foreignTableName: 'Project',
      },
    ]);

    await expectConstraintViolation(
      client,
      `DELETE FROM "Workspace" WHERE "id" = $1`,
      [project.workspaceId],
    );
    await client.query(`DELETE FROM "Project" WHERE "id" = $1`, [project.id]);
    await expect(
      client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM "ProjectRevision" WHERE "projectId" = $1`,
        [project.id],
      ),
    ).resolves.toMatchObject({ rows: [{ count: '0' }] });
  });

  it('enforces Project public slug and per-workspace operation uniqueness', async () => {
    const first = await insertProject(client);

    await expectConstraintViolation(
      client,
      `INSERT INTO "Project"
         ("id", "workspaceId", "createOperationId", "name", "publicSlug",
          "draft", "draftSchemaVersion", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'Duplicate operation', $4, '{}'::jsonb, 4,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        randomUUID(),
        first.workspaceId,
        first.createOperationId,
        `other-${randomUUID()}`,
      ],
    );

    const otherWorkspaceId = await insertWorkspace(client);
    await expectConstraintViolation(
      client,
      `INSERT INTO "Project"
         ("id", "workspaceId", "createOperationId", "name", "publicSlug",
          "draft", "draftSchemaVersion", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 'Duplicate slug', $4, '{}'::jsonb, 4,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [randomUUID(), otherWorkspaceId, randomUUID(), first.publicSlug],
    );
  });

  it('enforces ProjectRevision version and operation uniqueness per project', async () => {
    const project = await insertProject(client);
    const operationId = randomUUID();
    await client.query(
      `INSERT INTO "ProjectRevision"
         ("id", "projectId", "operationId", "version", "siteConfig",
          "schemaVersion")
       VALUES ($1, $2, $3, 1, '{}'::jsonb, 4)`,
      [randomUUID(), project.id, operationId],
    );

    await expectConstraintViolation(
      client,
      `INSERT INTO "ProjectRevision"
         ("id", "projectId", "operationId", "version", "siteConfig",
          "schemaVersion")
       VALUES ($1, $2, $3, 1, '{}'::jsonb, 4)`,
      [randomUUID(), project.id, randomUUID()],
    );
    await expectConstraintViolation(
      client,
      `INSERT INTO "ProjectRevision"
         ("id", "projectId", "operationId", "version", "siteConfig",
          "schemaVersion")
       VALUES ($1, $2, $3, 2, '{}'::jsonb, 4)`,
      [randomUUID(), project.id, operationId],
    );
  });
});
