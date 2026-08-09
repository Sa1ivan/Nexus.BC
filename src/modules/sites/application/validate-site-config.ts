import { validateAndCanonicalizeSiteConfigV4Json } from '../domain/site-config-v4';
import type { SiteConfigDocument } from '../domain/site-config-v4';
import { SitesApplicationError } from './sites-errors';

export function requireCanonicalSiteConfig(value: unknown): SiteConfigDocument {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new SitesApplicationError('VALIDATION_ERROR');
  }
  if (serialized === undefined) {
    throw new SitesApplicationError('VALIDATION_ERROR');
  }
  const validation = validateAndCanonicalizeSiteConfigV4Json(serialized);
  if (!validation.ok) throw new SitesApplicationError('VALIDATION_ERROR');
  return validation.value;
}
