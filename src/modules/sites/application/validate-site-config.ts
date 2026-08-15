import type { SiteConfigRolloutMode } from '../../../shared/config/app-config.schema';
import {
  type CanonicalSiteConfigInput,
  siteConfigWriteHandlers,
} from '../domain/site-config-write-handlers';
import { SitesApplicationError } from './sites-errors';

export function requireCanonicalSiteConfig(
  value: unknown,
  mode: SiteConfigRolloutMode,
): CanonicalSiteConfigInput {
  try {
    return siteConfigWriteHandlers[mode].canonicalizeInput(value);
  } catch {
    throw new SitesApplicationError('VALIDATION_ERROR');
  }
}
