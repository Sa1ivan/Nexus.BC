import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppConfig } from '../../../shared/config/app-config.schema';
import type { TransactionContext } from '../../../shared/database/transaction-runner';
import {
  PrismaTransactionClientService,
  type TransactionRunner,
} from '../../../shared/database/transaction-runner';
import type { CanonicalSiteConfigInput } from '../domain/site-config-write-handlers';
import { validateAndCanonicalizeSiteConfigV4Json } from '../domain/site-config-v4';
import { SiteConfigRolloutGuard } from './site-config-rollout-guard';

const context = Object.freeze({}) as TransactionContext;
function validV4Input(): CanonicalSiteConfigInput {
  const validation = validateAndCanonicalizeSiteConfigV4Json(
    readFileSync(
      resolve('contracts/site-config/fixtures/v4-full-valid.json'),
      'utf8',
    ),
  );
  if (!validation.ok) throw new Error('Expected valid v4 fixture');
  return { document: validation.value, schemaVersion: 4 };
}

const v4Input = validV4Input();
const v5Input = {
  document: { schemaVersion: 5 },
  schemaVersion: 5,
} as const satisfies CanonicalSiteConfigInput;

function configuration(
  siteConfigRolloutMode: AppConfig['siteConfigRolloutMode'],
): AppConfig {
  return {
    siteConfigRolloutMode,
  } as AppConfig;
}

function guardFixture(input: {
  readonly marker: { readonly v5ActivatedAt: Date } | null;
  readonly mode: AppConfig['siteConfigRolloutMode'];
}) {
  const trace: string[] = [];
  const transaction = {
    $executeRawUnsafe: () => {
      trace.push('lock');
      return Promise.resolve(1);
    },
    siteConfigRolloutState: {
      findUnique: () => {
        trace.push('marker');
        return Promise.resolve(input.marker);
      },
    },
  };
  const transactions = {
    [PrismaTransactionClientService]: async (
      suppliedContext: TransactionContext,
      work: (client: unknown) => Promise<unknown>,
    ) => {
      expect(suppliedContext).toBe(context);
      return work(transaction);
    },
  } as TransactionRunner;
  const reader = transaction;
  return {
    guard: new SiteConfigRolloutGuard(
      transactions,
      reader,
      configuration(input.mode),
    ),
    trace,
  };
}

describe('SiteConfig rollout storage guard', () => {
  it('allows V4_COMPAT writes only before the activation marker', async () => {
    const allowed = guardFixture({ mode: 'V4_COMPAT', marker: null });
    await expect(allowed.guard.prepareWrite(context, v4Input)).resolves.toEqual(
      v4Input,
    );
    expect(allowed.trace).toEqual(['lock', 'marker']);

    const rejected = guardFixture({
      mode: 'V4_COMPAT',
      marker: { v5ActivatedAt: new Date('2026-08-15T00:00:00.000Z') },
    });
    await expect(rejected.guard.prepareWrite(context, v4Input)).rejects.toThrow(
      'SITE_CONFIG_ROLLOUT_MISMATCH',
    );
  });

  it('allows V5_ACTIVE writes only after the activation marker', async () => {
    const rejected = guardFixture({ mode: 'V5_ACTIVE', marker: null });
    await expect(rejected.guard.prepareWrite(context, v5Input)).rejects.toThrow(
      'SITE_CONFIG_ROLLOUT_MISMATCH',
    );

    const allowed = guardFixture({
      mode: 'V5_ACTIVE',
      marker: { v5ActivatedAt: new Date('2026-08-15T00:00:00.000Z') },
    });
    await expect(allowed.guard.prepareWrite(context, v4Input)).resolves.toEqual(
      expect.objectContaining({ schemaVersion: 5 }),
    );
    expect(allowed.trace).toEqual(['lock', 'marker']);
  });

  it('reports readiness from the same fail-closed truth table', async () => {
    await expect(
      guardFixture({ mode: 'V4_COMPAT', marker: null }).guard.isReady(),
    ).resolves.toBe(true);
    await expect(
      guardFixture({
        mode: 'V4_COMPAT',
        marker: { v5ActivatedAt: new Date() },
      }).guard.isReady(),
    ).resolves.toBe(false);
    await expect(
      guardFixture({ mode: 'V5_ACTIVE', marker: null }).guard.isReady(),
    ).resolves.toBe(false);
    await expect(
      guardFixture({
        mode: 'V5_ACTIVE',
        marker: { v5ActivatedAt: new Date() },
      }).guard.isReady(),
    ).resolves.toBe(true);
  });
});
