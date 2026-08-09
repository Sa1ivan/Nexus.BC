import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  APP_CONFIG,
  type AppConfig,
} from '../../../shared/config/app-config.schema';
import {
  type SiteConfigDocument,
  validateAndCanonicalizeSiteConfigV4Json,
} from '../domain/site-config-v4';
import { SitesApplicationError } from './sites-errors';
import { SITE_REPOSITORY, type SiteRepository } from './sites.ports';

export interface PublicSiteRepresentation {
  readonly releaseId: string;
  readonly releaseVersion: number;
  readonly schemaVersion: 4;
  readonly theme: unknown;
  readonly business: unknown;
  readonly seo: unknown;
  readonly chrome: unknown;
  readonly page: Readonly<Record<string, unknown>>;
  readonly privacyNotice: {
    readonly url: string;
    readonly version: string;
  };
}

export interface PublicSiteResult {
  readonly etag: string;
  readonly notModified: boolean;
  readonly representation: PublicSiteRepresentation;
}

export type PublicSiteConfiguration = Pick<
  AppConfig,
  'privacyNoticeUrl' | 'privacyNoticeVersion'
>;

export type PublicSiteRepository = Pick<
  SiteRepository,
  'findActiveReleaseByPublicSlug'
>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function selectedPage(
  siteConfig: SiteConfigDocument,
  pageSlug: string | undefined,
): Readonly<Record<string, unknown>> {
  const pages = siteConfig['pages'];
  if (!Array.isArray(pages)) {
    throw new Error('Stored release pages must be an array');
  }
  const pageValues = pages as readonly unknown[];
  const page =
    pageSlug === undefined
      ? pageValues[0]
      : pageValues.find(
          (candidate) => isRecord(candidate) && candidate['slug'] === pageSlug,
        );
  if (page === undefined && pageSlug !== undefined) {
    throw new SitesApplicationError('NOT_FOUND');
  }
  if (!isRecord(page)) {
    throw new Error('Stored release page must be an object');
  }
  return page;
}

function validatedStoredSiteConfig(
  siteConfig: SiteConfigDocument,
): SiteConfigDocument {
  let serialized: string;
  try {
    const candidate = JSON.stringify(siteConfig);
    if (candidate === undefined) throw new Error('not JSON');
    serialized = candidate;
  } catch {
    throw new Error('Stored release SiteConfig v4 snapshot is invalid');
  }
  const validated = validateAndCanonicalizeSiteConfigV4Json(serialized);
  if (!validated.ok) {
    throw new Error('Stored release SiteConfig v4 snapshot is invalid');
  }
  return validated.value;
}

function representationEtag(representation: PublicSiteRepresentation): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(representation), 'utf8')
    .digest('base64url');
  return `"${digest}"`;
}

function matchesIfNoneMatch(value: string | undefined, etag: string): boolean {
  if (value === undefined) return false;
  let index = 0;
  const skipOptionalWhitespace = (): void => {
    while (value[index] === ' ' || value[index] === '\t') index += 1;
  };
  skipOptionalWhitespace();
  if (value[index] === '*') {
    index += 1;
    skipOptionalWhitespace();
    return index === value.length;
  }

  const opaqueTags: string[] = [];
  while (index < value.length) {
    if (value.startsWith('W/', index)) index += 2;
    if (value[index] !== '"') return false;
    const opaqueTagStart = index;
    index += 1;
    while (index < value.length && value[index] !== '"') {
      const code = value.charCodeAt(index);
      if (
        code !== 0x21 &&
        !(code >= 0x23 && code <= 0x7e) &&
        !(code >= 0x80 && code <= 0xff)
      ) {
        return false;
      }
      index += 1;
    }
    if (value[index] !== '"') return false;
    index += 1;
    opaqueTags.push(value.slice(opaqueTagStart, index));
    skipOptionalWhitespace();
    if (index === value.length) break;
    if (value[index] !== ',') return false;
    index += 1;
    skipOptionalWhitespace();
    if (index === value.length || value[index] === '*') return false;
  }
  return opaqueTags.includes(etag);
}

@Injectable()
export class GetPublicSite {
  constructor(
    @Inject(SITE_REPOSITORY)
    private readonly repository: PublicSiteRepository,
    @Inject(APP_CONFIG)
    private readonly configuration: PublicSiteConfiguration,
  ) {}

  async execute(input: {
    readonly publicSlug: string;
    readonly pageSlug?: string;
    readonly ifNoneMatch?: string;
  }): Promise<PublicSiteResult> {
    const release = await this.repository.findActiveReleaseByPublicSlug(
      input.publicSlug,
    );
    if (release === null) throw new SitesApplicationError('NOT_FOUND');
    const siteConfig = validatedStoredSiteConfig(release.siteConfig);
    const page = selectedPage(siteConfig, input.pageSlug);
    const representation: PublicSiteRepresentation = {
      releaseId: release.id,
      releaseVersion: release.version,
      schemaVersion: release.schemaVersion,
      theme: siteConfig['theme'],
      business: siteConfig['business'],
      seo: siteConfig['seo'],
      chrome: siteConfig['chrome'],
      page,
      privacyNotice: {
        url: this.configuration.privacyNoticeUrl,
        version: this.configuration.privacyNoticeVersion,
      },
    };
    const etag = representationEtag(representation);
    return {
      etag,
      notModified: matchesIfNoneMatch(input.ifNoneMatch, etag),
      representation,
    };
  }
}
