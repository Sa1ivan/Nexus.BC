import { randomUUID } from 'node:crypto';
import { DatabaseError, Pool } from 'pg';
import {
  SITECONFIG_ROLLOUT_LOCK_ID,
  SITE_CONFIG_ROLLOUT_STATE_KEY,
} from '../../src/modules/sites/infrastructure/site-config-rollout-guard';

async function expectDatabaseCode(
  pool: Pool,
  statement: string,
  values: readonly unknown[],
  expectedCode: string,
): Promise<void> {
  const client = await pool.connect();
  const savepoint = `rollout_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query('BEGIN');
    await client.query(`SAVEPOINT ${savepoint}`);
    let rejection: unknown;
    try {
      await client.query(statement, [...values]);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(DatabaseError);
    if (!(rejection instanceof DatabaseError)) {
      throw new Error('Expected a PostgreSQL rejection');
    }
    expect(rejection.code).toBe(expectedCode);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('SiteConfig rollout PostgreSQL guard', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('has the exact singleton marker schema', async () => {
    const columns = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: 'YES' | 'NO';
    }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'SiteConfigRolloutState'
        ORDER BY ordinal_position`,
    );
    expect(columns.rows).toEqual([
      { column_name: 'key', data_type: 'character varying', is_nullable: 'NO' },
      {
        column_name: 'v5ActivatedAt',
        data_type: 'timestamp without time zone',
        is_nullable: 'NO',
      },
    ]);
    await expectDatabaseCode(
      pool,
      `INSERT INTO "SiteConfigRolloutState" ("key", "v5ActivatedAt")
       VALUES ($1, CURRENT_TIMESTAMP)`,
      ['other-key'],
      '23514',
    );
  });

  it.each([
    `UPDATE "SiteConfigRolloutState" SET "v5ActivatedAt" = CURRENT_TIMESTAMP`,
    `DELETE FROM "SiteConfigRolloutState"`,
    `TRUNCATE TABLE "SiteConfigRolloutState"`,
  ])('rejects immutable marker mutation: %s', async (statement) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO "SiteConfigRolloutState" ("key", "v5ActivatedAt")
         VALUES ($1, CURRENT_TIMESTAMP)`,
        [SITE_CONFIG_ROLLOUT_STATE_KEY],
      );
      let rejection: unknown;
      try {
        await client.query(statement);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(DatabaseError);
      if (!(rejection instanceof DatabaseError)) {
        throw new Error('Expected an immutable marker rejection');
      }
      expect(rejection.code).toBe('55000');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('serializes an activation attempt and a writer on the same advisory lock', async () => {
    const activation = await pool.connect();
    const writer = await pool.connect();
    let writerSettled = false;
    try {
      await activation.query('BEGIN');
      await activation.query('SELECT pg_advisory_xact_lock($1::bigint)', [
        SITECONFIG_ROLLOUT_LOCK_ID.toString(),
      ]);
      await activation.query(
        `INSERT INTO "SiteConfigRolloutState" ("key", "v5ActivatedAt")
         VALUES ($1, CURRENT_TIMESTAMP)`,
        [SITE_CONFIG_ROLLOUT_STATE_KEY],
      );

      await writer.query('BEGIN');
      const writerLock = writer
        .query('SELECT pg_advisory_xact_lock($1::bigint)', [
          SITECONFIG_ROLLOUT_LOCK_ID.toString(),
        ])
        .then(() => {
          writerSettled = true;
        });
      await new Promise<void>((resolvePromise) => {
        setImmediate(resolvePromise);
      });
      expect(writerSettled).toBe(false);

      await activation.query('ROLLBACK');
      await writerLock;
      const marker = await writer.query(
        `SELECT "v5ActivatedAt"
           FROM "SiteConfigRolloutState"
          WHERE "key" = $1`,
        [SITE_CONFIG_ROLLOUT_STATE_KEY],
      );
      expect(marker.rowCount).toBe(0);
    } finally {
      await activation.query('ROLLBACK');
      await writer.query('ROLLBACK');
      activation.release();
      writer.release();
    }
  });
});
