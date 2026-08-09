import { readFileSync } from 'node:fs';

import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';
import { resolveSiteConfigSchemaPath } from './site-config-schema-loader';

export const SITE_CONFIG_V4_CANONICAL_BYTES_LIMIT = 1_048_576;
export const SITE_CONFIG_V4_JSON_ENVELOPE_BYTES_LIMIT = 1_310_720;
export const SITE_CONFIG_V4_MAX_JSON_DEPTH = 32;

export type SiteConfigDocument = Readonly<Record<string, unknown>>;

export type SiteConfigV4ValidationErrorCode =
  | 'json-envelope-too-large'
  | 'invalid-json'
  | 'json-depth-exceeded'
  | 'unsupported-schema'
  | 'invalid-site-config'
  | 'canonical-document-too-large';

export type SiteConfigV4ValidationResult =
  | {
      readonly ok: true;
      readonly value: SiteConfigDocument;
      readonly canonicalJson: string;
      readonly canonicalBytes: number;
    }
  | { readonly ok: false; readonly code: SiteConfigV4ValidationErrorCode };

const RESERVED_PAGE_SLUGS = new Set([
  'builder',
  'create',
  'projects',
  'statistics',
  'profile',
  'contacts',
  'p',
]);

const siteConfigSchemaPath = resolveSiteConfigSchemaPath(__dirname);
const schema = JSON.parse(readFileSync(siteConfigSchemaPath, 'utf8')) as object;
const validateSchema: ValidateFunction = new Ajv({
  allErrors: false,
  strict: true,
}).compile(schema);

export function validateAndCanonicalizeSiteConfigV4Json(
  serialized: string,
): SiteConfigV4ValidationResult {
  if (
    Buffer.byteLength(serialized) > SITE_CONFIG_V4_JSON_ENVELOPE_BYTES_LIMIT
  ) {
    return failure('json-envelope-too-large');
  }

  if (exceedsSiteConfigJsonDepth(serialized, SITE_CONFIG_V4_MAX_JSON_DEPTH)) {
    return failure('json-depth-exceeded');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    return failure('invalid-json');
  }

  if (!isRecord(parsed)) {
    return failure('invalid-site-config');
  }

  if (parsed['schemaVersion'] !== 4) {
    return typeof parsed['schemaVersion'] === 'number'
      ? failure('unsupported-schema')
      : failure('invalid-site-config');
  }

  if (!validateSchema(parsed) || !hasValidSiteConfigSemantics(parsed)) {
    return failure('invalid-site-config');
  }

  const canonicalValue = canonicalizeBundledMediaPaths(
    parsed,
  ) as SiteConfigDocument;
  const canonicalJson = stableJsonStringify(canonicalValue);
  const canonicalBytes = Buffer.byteLength(canonicalJson);

  if (canonicalBytes > SITE_CONFIG_V4_CANONICAL_BYTES_LIMIT) {
    return failure('canonical-document-too-large');
  }

  return { ok: true, value: canonicalValue, canonicalJson, canonicalBytes };
}

function failure(
  code: SiteConfigV4ValidationErrorCode,
): SiteConfigV4ValidationResult {
  return { ok: false, code };
}

function exceedsSiteConfigJsonDepth(
  serialized: string,
  maximumDepth: number,
): boolean {
  let depth = 0;
  let insideString = false;
  let escaped = false;

  for (const character of serialized) {
    if (insideString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        insideString = false;
      }
      continue;
    }

    if (character === '"') {
      insideString = true;
    } else if (character === '{' || character === '[') {
      depth += 1;
      if (depth > maximumDepth) return true;
    } else if (character === '}' || character === ']') {
      depth -= 1;
    }
  }

  return false;
}

function hasValidSiteConfigSemantics(
  siteConfig: Record<string, unknown>,
): boolean {
  const pages = siteConfig['pages'];
  const chrome = siteConfig['chrome'];
  if (!Array.isArray(pages) || !isRecord(chrome)) return false;

  const header = chrome['header'];
  const footer = chrome['footer'];
  if (!isRecord(header) || !isRecord(footer)) return false;

  const blockIds = new Set<string>();
  const sharedAnchors = new Set<string>();
  if (
    !addUniqueString(blockIds, header['id']) ||
    !addUniqueString(blockIds, footer['id'])
  ) {
    return false;
  }
  if (
    !addUniqueString(sharedAnchors, header['anchor']) ||
    !addUniqueString(sharedAnchors, footer['anchor'])
  ) {
    return false;
  }

  const pageIds = new Set<string>();
  const pageSlugs = new Set<string>();
  for (const pageValue of pages) {
    if (!isRecord(pageValue)) return false;
    const pageId = pageValue['id'];
    const slug = pageValue['slug'];
    if (!addUniqueString(pageIds, pageId) || !addUniqueString(pageSlugs, slug))
      return false;
    if (typeof slug !== 'string' || RESERVED_PAGE_SLUGS.has(slug)) return false;

    const blocks = pageValue['blocks'];
    if (!Array.isArray(blocks)) return false;
    const renderedAnchors = new Set(sharedAnchors);
    for (const blockValue of blocks) {
      if (!isRecord(blockValue)) return false;
      if (
        blockValue['type'] === 'siteHeader' ||
        blockValue['type'] === 'siteFooter'
      )
        return false;
      if (
        !addUniqueString(blockIds, blockValue['id']) ||
        !addUniqueString(renderedAnchors, blockValue['anchor']) ||
        !hasUniqueContainedIds(blockValue)
      ) {
        return false;
      }
    }
  }

  if (!hasUniqueIdsInContainingArrays(siteConfig)) return false;

  return visitRecords(siteConfig, (record) => {
    if (
      typeof record['src'] === 'string' &&
      typeof record['alt'] === 'string'
    ) {
      return isSafeCloudMediaSource(record['src']);
    }

    if (
      typeof record['embedUrl'] === 'string' &&
      (!isSafeCloudLinkTarget(record['embedUrl']) ||
        !isCredentialFreeHttpsUrl(record['embedUrl']))
    ) {
      return false;
    }

    if (
      typeof record['buttonHref'] === 'string' &&
      !isSafeCloudLinkTarget(record['buttonHref'])
    ) {
      return false;
    }

    if (typeof record['target'] === 'string') {
      if (!isSafeCloudLinkTarget(record['target'])) return false;
      if (
        typeof record['kind'] !== 'string' ||
        !doesLinkKindMatchTarget(record['kind'], record['target'])
      ) {
        return false;
      }
    }
    return true;
  });
}

function hasUniqueIdsInContainingArrays(value: unknown): boolean {
  if (Array.isArray(value)) {
    const recordsWithIds = value.filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) && typeof item['id'] === 'string',
    );
    if (recordsWithIds.length > 0) {
      const ids = new Set(
        recordsWithIds.map((record) => record['id'] as string),
      );
      if (ids.size !== recordsWithIds.length) return false;
    }
    return value.every(hasUniqueIdsInContainingArrays);
  }

  return (
    !isRecord(value) ||
    Object.values(value).every(hasUniqueIdsInContainingArrays)
  );
}

function hasUniqueContainedIds(block: Record<string, unknown>): boolean {
  const collectionTypes = new Set([
    'featureGrid',
    'offerList',
    'gallery',
    'testimonials',
    'faq',
  ]);
  const values =
    block['type'] === 'leadForm'
      ? block['fields']
      : collectionTypes.has(String(block['type']))
        ? block['items']
        : undefined;

  if (values === undefined) return true;
  if (!Array.isArray(values)) return false;

  const ids = new Set<string>();
  return values.every(
    (value) => isRecord(value) && addUniqueString(ids, value['id']),
  );
}

function addUniqueString(values: Set<string>, value: unknown): boolean {
  if (typeof value !== 'string' || values.has(value)) return false;
  values.add(value);
  return true;
}

function isSafeCloudMediaSource(source: string): boolean {
  if (
    [...source].length > 2_048 ||
    hasControlCharacter(source) ||
    source.includes('\\') ||
    source !== source.trim()
  )
    return false;

  if (source.startsWith('https://')) {
    return (
      !hasEncodedPathHazard(source) &&
      !/(?:^|\/)\.\.(?:\/|$)/u.test(source) &&
      isCredentialFreeHttpsUrl(source)
    );
  }
  if (!source.startsWith('images/') && !source.startsWith('./images/'))
    return false;
  if (
    source.includes('\\') ||
    source.includes('?') ||
    source.includes('#') ||
    hasEncodedPathHazard(source)
  ) {
    return false;
  }

  const normalized = source.startsWith('./') ? source.slice(2) : source;
  const segments = normalized.slice('images/'.length).split('/');
  return (
    segments.length > 0 &&
    segments.every(
      (segment) => segment !== '' && segment !== '.' && segment !== '..',
    )
  );
}

function isSafeCloudLinkTarget(target: string): boolean {
  if (
    [...target].length > 2_048 ||
    target !== target.trim() ||
    hasControlCharacter(target) ||
    target.includes('\\') ||
    hasEncodedPathHazard(target) ||
    /(?:^|\/)\.\.(?:\/|$)/u.test(target)
  ) {
    return false;
  }

  if (target.startsWith('#')) return target.length > 1 && !/\s/u.test(target);
  if (target.startsWith('/')) return !target.startsWith('//');
  if (target.startsWith('https://')) return isCredentialFreeHttpsUrl(target);
  if (target.startsWith('mailto:'))
    return /^mailto:[^\s@]+@[^\s@]+$/u.test(target);
  if (target.startsWith('tel:'))
    return /^tel:\+?[0-9()\-\s]{3,32}$/u.test(target);
  return false;
}

function doesLinkKindMatchTarget(kind: string, target: string): boolean {
  switch (kind) {
    case 'anchor':
      return target.startsWith('#');
    case 'internal':
      return target.startsWith('/') && !target.startsWith('//');
    case 'external':
      return target.startsWith('https://');
    case 'email':
      return target.startsWith('mailto:');
    case 'phone':
      return target.startsWith('tel:');
    default:
      return false;
  }
}

function hasEncodedPathHazard(value: string): boolean {
  let candidate = value;

  for (let pass = 0; pass < 4; pass += 1) {
    if (/%(?:0[0-9a-f]|1[0-9a-f]|7f|2e|2f|5c)/iu.test(candidate)) return true;

    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return true;
    }

    if (decoded === candidate) return false;
    if (
      hasControlCharacter(decoded) ||
      decoded.includes('\\') ||
      /(?:^|\/)\.\.(?:\/|$)/u.test(decoded)
    ) {
      return true;
    }
    candidate = decoded;
  }

  return candidate.includes('%');
}

function isCredentialFreeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname.length > 0 &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function visitRecords(
  value: unknown,
  visitor: (record: Record<string, unknown>) => boolean,
): boolean {
  if (Array.isArray(value))
    return value.every((item) => visitRecords(item, visitor));
  if (!isRecord(value)) return true;
  if (!visitor(value)) return false;
  return Object.values(value).every((item) => visitRecords(item, visitor));
}

function canonicalizeBundledMediaPaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeBundledMediaPaths);
  if (!isRecord(value)) return value;

  const entries = Object.entries(value).map(([key, item]) => {
    if (
      key === 'src' &&
      typeof item === 'string' &&
      item.startsWith('./images/')
    ) {
      return [key, item.slice(2)] as const;
    }
    return [key, canonicalizeBundledMediaPaths(item)] as const;
  });
  return Object.fromEntries(entries);
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(stableJsonStringify).join(',')}]`;

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
