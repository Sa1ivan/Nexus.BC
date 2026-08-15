import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrationPath = resolve(
  'prisma/migrations/20260815120000_site_config_v5_rollout/migration.sql',
);

describe('SiteConfig rollout persistence contract', () => {
  it('creates one immutable monotonic activation marker', () => {
    const schema = readFileSync(resolve('prisma/schema.prisma'), 'utf8');
    const migration = readFileSync(migrationPath, 'utf8');

    expect(schema).toMatch(
      /model SiteConfigRolloutState\s*\{[\s\S]*key\s+String\s+@id\s+@db\.VarChar\(32\)[\s\S]*v5ActivatedAt\s+DateTime[\s\S]*\}/u,
    );
    expect(migration).toMatch(
      /CREATE TABLE "SiteConfigRolloutState"[\s\S]*"key" VARCHAR\(32\) NOT NULL[\s\S]*"v5ActivatedAt" TIMESTAMP\(3\) NOT NULL/u,
    );
    expect(migration).toMatch(/CHECK\s*\(\s*"key"\s*=\s*'site-config'\s*\)/u);
    expect(migration).toMatch(/PRIMARY KEY \("key"\)/u);
    expect(migration).toMatch(
      /BEFORE UPDATE OR DELETE ON "SiteConfigRolloutState"/u,
    );
    expect(migration).toMatch(/BEFORE TRUNCATE ON "SiteConfigRolloutState"/u);
  });
});
