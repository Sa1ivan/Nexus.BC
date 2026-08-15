import type { SiteConfigRolloutMode } from './app-config.schema';

export type SiteConfigSchemaVersion = 4 | 5;

export type SiteConfigCapabilities =
  | {
      readonly rolloutMode: 'V4_COMPAT';
      readonly readVersions: readonly [4, 5];
      readonly acceptedInputVersions: readonly [4];
      readonly writeVersion: 4;
    }
  | {
      readonly rolloutMode: 'V5_ACTIVE';
      readonly readVersions: readonly [4, 5];
      readonly acceptedInputVersions: readonly [4, 5];
      readonly writeVersion: 5;
    };

interface SiteConfigRolloutHandler {
  readonly capabilities: SiteConfigCapabilities;
}

export const siteConfigRolloutHandlers = {
  V4_COMPAT: {
    capabilities: {
      rolloutMode: 'V4_COMPAT',
      readVersions: [4, 5],
      acceptedInputVersions: [4],
      writeVersion: 4,
    },
  },
  V5_ACTIVE: {
    capabilities: {
      rolloutMode: 'V5_ACTIVE',
      readVersions: [4, 5],
      acceptedInputVersions: [4, 5],
      writeVersion: 5,
    },
  },
} as const satisfies Readonly<
  Record<SiteConfigRolloutMode, SiteConfigRolloutHandler>
>;
