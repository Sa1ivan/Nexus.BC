import { Inject, Injectable } from '@nestjs/common';
import {
  APP_CONFIG,
  type AppConfig,
} from '../../../shared/config/app-config.schema';
import { PrismaClientService } from '../../../shared/database/prisma.service';
import type { TransactionContext } from '../../../shared/database/transaction-runner';
import {
  PrismaTransactionClientService,
  TransactionRunner,
} from '../../../shared/database/transaction-runner';
import type { CanonicalSiteConfigInput } from '../domain/site-config-write-handlers';
import {
  type PreparedSiteConfigWrite,
  siteConfigWriteHandlers,
} from '../domain/site-config-write-handlers';

export const SITE_CONFIG_ROLLOUT_STATE_KEY = 'site-config';
export const SITECONFIG_ROLLOUT_LOCK_ID = 22_034_141_833_582_133n;

interface SiteConfigRolloutMarker {
  readonly v5ActivatedAt: Date;
}

interface SiteConfigRolloutStateDelegate {
  findUnique(
    arguments_: Readonly<Record<string, unknown>>,
  ): Promise<SiteConfigRolloutMarker | null>;
}

interface SiteConfigRolloutReader {
  readonly siteConfigRolloutState: SiteConfigRolloutStateDelegate;
}

interface SiteConfigRolloutTransaction extends SiteConfigRolloutReader {
  $executeRawUnsafe(
    query: string,
    ...values: readonly unknown[]
  ): Promise<unknown>;
}

@Injectable()
export class SiteConfigRolloutGuard {
  constructor(
    private readonly transactions: TransactionRunner,
    @Inject(PrismaClientService)
    private readonly reader: SiteConfigRolloutReader,
    @Inject(APP_CONFIG)
    private readonly configuration: Pick<AppConfig, 'siteConfigRolloutMode'>,
  ) {}

  async prepareWrite(
    context: TransactionContext,
    input: CanonicalSiteConfigInput,
  ): Promise<PreparedSiteConfigWrite> {
    return this.transactions[PrismaTransactionClientService](
      context,
      async (client) => {
        const transaction = client as SiteConfigRolloutTransaction;
        await transaction.$executeRawUnsafe(
          'SELECT pg_advisory_xact_lock($1::bigint)',
          SITECONFIG_ROLLOUT_LOCK_ID.toString(),
        );
        const marker = await this.readMarker(transaction);
        this.assertModeMatchesMarker(marker);
        return siteConfigWriteHandlers[
          this.configuration.siteConfigRolloutMode
        ].prepareWrite(input);
      },
    );
  }

  async isReady(): Promise<boolean> {
    try {
      const marker = await this.readMarker(this.reader);
      return this.modeMatchesMarker(marker);
    } catch {
      return false;
    }
  }

  private readMarker(
    reader: SiteConfigRolloutReader,
  ): Promise<SiteConfigRolloutMarker | null> {
    return reader.siteConfigRolloutState.findUnique({
      where: { key: SITE_CONFIG_ROLLOUT_STATE_KEY },
      select: { v5ActivatedAt: true },
    });
  }

  private assertModeMatchesMarker(
    marker: SiteConfigRolloutMarker | null,
  ): void {
    if (!this.modeMatchesMarker(marker)) {
      throw new Error('SITE_CONFIG_ROLLOUT_MISMATCH');
    }
  }

  private modeMatchesMarker(marker: SiteConfigRolloutMarker | null): boolean {
    return this.configuration.siteConfigRolloutMode === 'V4_COMPAT'
      ? marker === null
      : marker !== null;
  }
}
