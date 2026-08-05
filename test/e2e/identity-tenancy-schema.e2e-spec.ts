import { randomUUID } from 'node:crypto';
import { DatabaseError, Pool, type PoolClient } from 'pg';

const IDENTITY_TABLES = [
  'User',
  'Workspace',
  'Membership',
  'RefreshSession',
  'EmailVerificationToken',
  'PasswordResetToken',
] as const;

async function columnNames(
  client: PoolClient,
  tableName: string,
): Promise<string[]> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [tableName],
  );
  return result.rows.map(({ column_name }) => column_name);
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
      await client.query(statement, values);
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

describe('identity and workspace tenancy schema', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
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

  it('creates the exact identity tables and OWNER/EDITOR workspace roles', async () => {
    const tableResult = await client.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [IDENTITY_TABLES],
    );
    expect(tableResult.rows.map(({ table_name }) => table_name)).toEqual(
      [...IDENTITY_TABLES].sort(),
    );

    const roleResult = await client.query<{ enumlabel: string }>(
      `SELECT enumlabel
         FROM pg_enum
         JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
        WHERE pg_type.typname = 'WorkspaceRole'
        ORDER BY enumsortorder`,
    );
    expect(roleResult.rows.map(({ enumlabel }) => enumlabel)).toEqual([
      'OWNER',
      'EDITOR',
    ]);
  });

  it('enforces canonical user email and one membership per workspace and user', async () => {
    const userId = randomUUID();
    const workspaceId = randomUUID();

    await expectConstraintViolation(
      client,
      `INSERT INTO "User" ("id", "email", "passwordHash", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [randomUUID(), 'Owner@Example.test', 'argon2id-hash'],
    );

    await client.query(
      `INSERT INTO "User" ("id", "email", "passwordHash", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [userId, 'owner@example.test', 'argon2id-hash'],
    );
    await client.query(
      `INSERT INTO "Workspace" ("id", "name", "createdAt", "updatedAt")
       VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [workspaceId, 'Owner workspace'],
    );
    await client.query(
      `INSERT INTO "Membership"
         ("workspaceId", "userId", "role", "createdAt", "updatedAt")
       VALUES ($1, $2, 'OWNER', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [workspaceId, userId],
    );

    await expectConstraintViolation(
      client,
      `INSERT INTO "Membership"
         ("workspaceId", "userId", "role", "createdAt", "updatedAt")
       VALUES ($1, $2, 'EDITOR', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [workspaceId, userId],
    );

    await expectConstraintViolation(
      client,
      `DELETE FROM "User" WHERE "id" = $1`,
      [userId],
    );
    const membershipCount = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM "Membership"
        WHERE "workspaceId" = $1 AND "userId" = $2`,
      [workspaceId, userId],
    );
    expect(membershipCount.rows[0]?.count).toBe('1');
  });

  it('defines hash-only secret columns and token lifecycle state', async () => {
    await expect(columnNames(client, 'User')).resolves.toEqual([
      'id',
      'email',
      'passwordHash',
      'emailVerifiedAt',
      'createdAt',
      'updatedAt',
    ]);
    await expect(columnNames(client, 'RefreshSession')).resolves.toEqual([
      'id',
      'userId',
      'familyId',
      'tokenHash',
      'expiresAt',
      'rotatedAt',
      'revokedAt',
      'createdAt',
    ]);
    await expect(
      columnNames(client, 'EmailVerificationToken'),
    ).resolves.toEqual([
      'id',
      'userId',
      'tokenHash',
      'expiresAt',
      'consumedAt',
      'createdAt',
    ]);
    await expect(columnNames(client, 'PasswordResetToken')).resolves.toEqual([
      'id',
      'userId',
      'tokenHash',
      'expiresAt',
      'consumedAt',
      'createdAt',
    ]);

    const tokenTables = [
      'RefreshSession',
      'EmailVerificationToken',
      'PasswordResetToken',
    ];
    for (const tableName of tokenTables) {
      const columns = await columnNames(client, tableName);
      expect(columns).toContain('tokenHash');
      for (const forbiddenColumn of [
        'token',
        'rawToken',
        'secret',
        'rawSecret',
      ]) {
        expect(columns).not.toContain(forbiddenColumn);
      }
      expect((await indexDefinitions(client, tableName)).join('\n')).toMatch(
        /UNIQUE.+"tokenHash"/u,
      );
    }

    expect(
      (await indexDefinitions(client, 'RefreshSession')).join('\n'),
    ).toMatch(/"familyId"/u);
  });
});
