import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import {
  loadAppConfig,
  type AppConfig,
} from '../../../src/shared/config/app-config.schema';
import { SITE_CONFIG_ROLLOUT_STATE_KEY } from '../../../src/modules/sites/infrastructure/site-config-rollout-guard';

function databaseUrlFor(databaseUrl: string, databaseName: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = `/${databaseName}`;
  parsed.searchParams.delete('schema');
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z0-9_]+$/u.test(identifier)) {
    throw new Error('Unsafe temporary database identifier');
  }
  return `"${identifier}"`;
}

async function applyMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const root = resolve('prisma/migrations');
    for (const directory of readdirSync(root).sort()) {
      const migration = resolve(root, directory, 'migration.sql');
      if (existsSync(migration)) {
        await pool.query(readFileSync(migration, 'utf8'));
      }
    }
  } finally {
    await pool.end();
  }
}

export interface V5TestDatabase {
  readonly configuration: AppConfig;
  readonly pool: Pool;
  dispose(): Promise<void>;
}

export async function createV5TestDatabase(
  prefix: string,
): Promise<V5TestDatabase> {
  const baseDatabaseUrl = process.env['DATABASE_URL'];
  if (baseDatabaseUrl === undefined) {
    throw new Error('DATABASE_URL is required for media E2E');
  }
  const databaseName = `${prefix}_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const adminPool = new Pool({
    connectionString: databaseUrlFor(baseDatabaseUrl, 'postgres'),
  });
  await adminPool.query(
    `CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE template0`,
  );
  const databaseUrl = databaseUrlFor(baseDatabaseUrl, databaseName);
  try {
    await applyMigrations(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl });
    await pool.query(
      `INSERT INTO "SiteConfigRolloutState" ("key", "v5ActivatedAt")
       VALUES ($1, CURRENT_TIMESTAMP)`,
      [SITE_CONFIG_ROLLOUT_STATE_KEY],
    );
    return {
      pool,
      configuration: {
        ...loadAppConfig(),
        databaseUrl,
        siteConfigRolloutMode: 'V5_ACTIVE',
      },
      dispose: async () => {
        await pool.end();
        await adminPool.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`,
        );
        await adminPool.end();
      },
    };
  } catch (error) {
    await adminPool.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`,
    );
    await adminPool.end();
    throw error;
  }
}
