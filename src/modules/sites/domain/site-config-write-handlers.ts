import type { SiteConfigRolloutMode } from '../../../shared/config/app-config.schema';
import { siteConfigRolloutHandlers } from '../../../shared/config/site-config-rollout';
import type { SiteConfigSchemaVersion } from '../../../shared/config/site-config-rollout';
import {
  type SiteConfigDocument,
  validateAndCanonicalizeSiteConfigV4Json,
} from './site-config-v4';
import {
  upconvertSiteConfigV4ToV5,
  validateAndCanonicalizeSiteConfigV5Json,
} from './site-config-v5';

export interface CanonicalSiteConfigInput {
  readonly document: SiteConfigDocument;
  readonly schemaVersion: SiteConfigSchemaVersion;
}

export interface PreparedSiteConfigWrite {
  readonly document: SiteConfigDocument;
  readonly schemaVersion: SiteConfigSchemaVersion;
}

interface SiteConfigWriteHandler {
  readonly capabilities: (typeof siteConfigRolloutHandlers)[SiteConfigRolloutMode]['capabilities'];
  canonicalizeInput(value: unknown): CanonicalSiteConfigInput;
  prepareWrite(input: CanonicalSiteConfigInput): PreparedSiteConfigWrite;
}

function serializeInput(value: unknown, mode: SiteConfigRolloutMode): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return serialized;
  } catch {
    // The stable public error below intentionally hides serialization details.
  }
  throw new Error(`SiteConfig input is invalid for ${mode}`);
}

function canonicalizeV4(
  value: unknown,
  mode: SiteConfigRolloutMode,
): CanonicalSiteConfigInput {
  const result = validateAndCanonicalizeSiteConfigV4Json(
    serializeInput(value, mode),
  );
  if (!result.ok) throw new Error(`SiteConfig input is invalid for ${mode}`);
  return { document: result.value, schemaVersion: 4 };
}

function canonicalizeV5(
  value: unknown,
  mode: SiteConfigRolloutMode,
): CanonicalSiteConfigInput {
  const result = validateAndCanonicalizeSiteConfigV5Json(
    serializeInput(value, mode),
  );
  if (!result.ok) throw new Error(`SiteConfig input is invalid for ${mode}`);
  return { document: result.value, schemaVersion: 5 };
}

function inputSchemaVersion(value: unknown): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)['schemaVersion']
    : undefined;
}

export const siteConfigWriteHandlers = {
  V4_COMPAT: {
    capabilities: siteConfigRolloutHandlers.V4_COMPAT.capabilities,
    canonicalizeInput(value: unknown): CanonicalSiteConfigInput {
      if (inputSchemaVersion(value) !== 4) {
        throw new Error('SiteConfig input is invalid for V4_COMPAT');
      }
      return canonicalizeV4(value, 'V4_COMPAT');
    },
    prepareWrite(input: CanonicalSiteConfigInput): PreparedSiteConfigWrite {
      if (input.schemaVersion !== 4) {
        throw new Error('SiteConfig input is invalid for V4_COMPAT');
      }
      return input;
    },
  },
  V5_ACTIVE: {
    capabilities: siteConfigRolloutHandlers.V5_ACTIVE.capabilities,
    canonicalizeInput(value: unknown): CanonicalSiteConfigInput {
      const version = inputSchemaVersion(value);
      if (version === 4) return canonicalizeV4(value, 'V5_ACTIVE');
      if (version === 5) return canonicalizeV5(value, 'V5_ACTIVE');
      throw new Error('SiteConfig input is invalid for V5_ACTIVE');
    },
    prepareWrite(input: CanonicalSiteConfigInput): PreparedSiteConfigWrite {
      if (input.schemaVersion === 5) return input;
      const document = upconvertSiteConfigV4ToV5(input.document);
      const validation = validateAndCanonicalizeSiteConfigV5Json(
        serializeInput(document, 'V5_ACTIVE'),
      );
      if (!validation.ok) {
        throw new Error('SiteConfig v4 up-conversion produced invalid v5');
      }
      return { document: validation.value, schemaVersion: 5 };
    },
  },
} as const satisfies Readonly<
  Record<SiteConfigRolloutMode, SiteConfigWriteHandler>
>;
