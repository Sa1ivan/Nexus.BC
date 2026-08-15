import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  APP_CONFIG,
  type AppConfig,
} from '../../../shared/config/app-config.schema';
import type { SiteConfigSchemaVersion } from '../../../shared/config/site-config-rollout';
import {
  MEDIA_PUBLIC_DELIVERY,
  type MediaPublicDelivery,
} from '../../media/application/public';
import {
  type SiteConfigDocument,
  validateAndCanonicalizeSiteConfigV4Json,
} from '../domain/site-config-v4';
import { validateAndCanonicalizeSiteConfigV5Json } from '../domain/site-config-v5';
import { managedMediaAssetIds } from './managed-media-references';
import { SitesApplicationError } from './sites-errors';
import { SITE_REPOSITORY, type SiteRepository } from './sites.ports';

export interface PublicSiteRepresentation {
  readonly releaseId: string;
  readonly releaseVersion: number;
  readonly schemaVersion: SiteConfigSchemaVersion;
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
  'privacyNoticeUrl' | 'privacyNoticeVersion' | 'webOrigins'
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
  schemaVersion: SiteConfigSchemaVersion,
): SiteConfigDocument {
  let serialized: string;
  try {
    const candidate = JSON.stringify(siteConfig);
    if (candidate === undefined) throw new Error('not JSON');
    serialized = candidate;
  } catch {
    throw new Error(
      `Stored release SiteConfig v${schemaVersion} snapshot is invalid`,
    );
  }
  const validated =
    schemaVersion === 4
      ? validateAndCanonicalizeSiteConfigV4Json(serialized)
      : validateAndCanonicalizeSiteConfigV5Json(serialized);
  if (!validated.ok) {
    throw new Error(
      `Stored release SiteConfig v${schemaVersion} snapshot is invalid`,
    );
  }
  return validated.value;
}

function projectPublicMediaValue(
  value: unknown,
  managedUrls: ReadonlyMap<string, string>,
  bundledAssetsOrigin: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      projectPublicMediaValue(entry, managedUrls, bundledAssetsOrigin),
    );
  }
  if (!isRecord(value)) return value;
  const alt = value['alt'];
  const focalPoint = value['focalPoint'];
  if (
    value['kind'] === 'managed' &&
    typeof value['assetId'] === 'string' &&
    typeof alt === 'string'
  ) {
    const src = managedUrls.get(value['assetId']);
    if (src === undefined) {
      throw new Error('Published managed media asset is unavailable');
    }
    return {
      src,
      alt,
      ...(focalPoint === undefined ? {} : { focalPoint }),
    };
  }
  if (
    value['kind'] === 'external' &&
    typeof value['src'] === 'string' &&
    typeof alt === 'string'
  ) {
    return {
      src: value['src'],
      alt,
      ...(focalPoint === undefined ? {} : { focalPoint }),
    };
  }
  if (
    value['kind'] === 'bundled' &&
    typeof value['path'] === 'string' &&
    typeof alt === 'string'
  ) {
    return {
      src: new URL(`/${value['path']}`, bundledAssetsOrigin).toString(),
      alt,
      ...(focalPoint === undefined ? {} : { focalPoint }),
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      projectPublicMediaValue(entry, managedUrls, bundledAssetsOrigin),
    ]),
  );
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
    @Inject(MEDIA_PUBLIC_DELIVERY)
    private readonly media: MediaPublicDelivery,
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
    const siteConfig = validatedStoredSiteConfig(
      release.siteConfig,
      release.schemaVersion,
    );
    const page = selectedPage(siteConfig, input.pageSlug);
    let managedUrls = new Map<string, string>();
    if (release.schemaVersion === 5) {
      const assetIds = managedMediaAssetIds(siteConfig);
      const resolved = await this.media.resolveProjectAssets({
        workspaceId: release.workspaceId,
        projectId: release.projectId,
        assetIds,
      });
      if (resolved === null || resolved.length !== assetIds.length) {
        throw new Error('Published managed media assets are unavailable');
      }
      managedUrls = new Map(
        resolved.map(({ assetId, deliveryUrl }) => [assetId, deliveryUrl]),
      );
    }
    const project = (value: unknown): unknown =>
      release.schemaVersion === 5
        ? projectPublicMediaValue(
            value,
            managedUrls,
            this.configuration.webOrigins[0]!,
          )
        : value;
    const representation: PublicSiteRepresentation = {
      releaseId: release.id,
      releaseVersion: release.version,
      schemaVersion: release.schemaVersion,
      theme: project(siteConfig['theme']),
      business: project(siteConfig['business']),
      seo: project(siteConfig['seo']),
      chrome: project(siteConfig['chrome']),
      page: project(page) as Readonly<Record<string, unknown>>,
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
