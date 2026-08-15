import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import type { ValidateFunction } from 'ajv';
import {
  SITE_CONFIG_V4_CANONICAL_BYTES_LIMIT,
  SITE_CONFIG_V4_JSON_ENVELOPE_BYTES_LIMIT,
  SITE_CONFIG_V4_MAX_JSON_DEPTH,
  type SiteConfigDocument,
  type SiteConfigV4ValidationErrorCode,
  validateAndCanonicalizeSiteConfigV4Json,
} from './site-config-v4';
import { resolveSiteConfigSchemaPath } from './site-config-schema-loader';

export type SiteConfigV5Document = SiteConfigDocument;

export type SiteConfigV5ValidationResult =
  | {
      readonly ok: true;
      readonly value: SiteConfigV5Document;
      readonly canonicalJson: string;
      readonly canonicalBytes: number;
    }
  | { readonly ok: false; readonly code: SiteConfigV4ValidationErrorCode };

const schema = JSON.parse(
  readFileSync(resolveSiteConfigSchemaPath(__dirname, 5), 'utf8'),
) as object;
const validateSchema: ValidateFunction = new Ajv({
  allErrors: false,
  strict: true,
}).compile(schema);

export function validateAndCanonicalizeSiteConfigV5Json(
  serialized: string,
): SiteConfigV5ValidationResult {
  if (
    Buffer.byteLength(serialized) > SITE_CONFIG_V4_JSON_ENVELOPE_BYTES_LIMIT
  ) {
    return failure('json-envelope-too-large');
  }
  if (exceedsJsonDepth(serialized, SITE_CONFIG_V4_MAX_JSON_DEPTH)) {
    return failure('json-depth-exceeded');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    return failure('invalid-json');
  }
  if (!isRecord(parsed)) return failure('invalid-site-config');
  if (parsed['schemaVersion'] !== 5) {
    return typeof parsed['schemaVersion'] === 'number'
      ? failure('unsupported-schema')
      : failure('invalid-site-config');
  }
  if (!validateSchema(parsed)) return failure('invalid-site-config');

  const semanticProxy = toV4SemanticProxy(parsed, true);
  const semanticValidation = validateAndCanonicalizeSiteConfigV4Json(
    stableJsonStringify(semanticProxy),
  );
  if (
    !semanticValidation.ok &&
    semanticValidation.code === 'invalid-site-config'
  ) {
    return failure('invalid-site-config');
  }

  const canonicalJson = stableJsonStringify(parsed);
  const canonicalBytes = Buffer.byteLength(canonicalJson);
  if (canonicalBytes > SITE_CONFIG_V4_CANONICAL_BYTES_LIMIT) {
    return failure('canonical-document-too-large');
  }
  return { ok: true, value: parsed, canonicalJson, canonicalBytes };
}

export function upconvertSiteConfigV4ToV5(
  document: SiteConfigDocument,
): SiteConfigV5Document {
  const converted = convertV4Value(document, true);
  if (!isRecord(converted)) {
    throw new Error('SiteConfig v4 up-conversion produced an invalid root');
  }
  return converted;
}

function failure(
  code: SiteConfigV4ValidationErrorCode,
): SiteConfigV5ValidationResult {
  return { ok: false, code };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mediaFocalPoint(
  record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return record['focalPoint'] === undefined
    ? {}
    : { focalPoint: record['focalPoint'] };
}

function isV4Media(record: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(record);
  return (
    typeof record['src'] === 'string' &&
    typeof record['alt'] === 'string' &&
    keys.every((key) => key === 'src' || key === 'alt' || key === 'focalPoint')
  );
}

function convertV4Value(value: unknown, root = false): unknown {
  if (Array.isArray(value)) return value.map((item) => convertV4Value(item));
  if (!isRecord(value)) return value;
  if (isV4Media(value)) {
    const src = value['src'] as string;
    return src.startsWith('images/')
      ? {
          kind: 'bundled',
          path: src,
          alt: value['alt'],
          ...mediaFocalPoint(value),
        }
      : {
          kind: 'external',
          src,
          alt: value['alt'],
          ...mediaFocalPoint(value),
        };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      root && key === 'schemaVersion' ? 5 : convertV4Value(item),
    ]),
  );
}

function toV4SemanticProxy(value: unknown, root = false): unknown {
  if (Array.isArray(value)) return value.map((item) => toV4SemanticProxy(item));
  if (!isRecord(value)) return value;

  const kind = value['kind'];
  if (kind === 'managed') {
    return {
      src: `https://managed.invalid/${encodeURIComponent(String(value['assetId']))}`,
      alt: value['alt'],
      ...mediaFocalPoint(value),
    };
  }
  if (kind === 'external') {
    return {
      src: value['src'],
      alt: value['alt'],
      ...mediaFocalPoint(value),
    };
  }
  if (kind === 'bundled') {
    return {
      src: value['path'],
      alt: value['alt'],
      ...mediaFocalPoint(value),
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      root && key === 'schemaVersion' ? 4 : toV4SemanticProxy(item),
    ]),
  );
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function exceedsJsonDepth(serialized: string, maximumDepth: number): boolean {
  let depth = 0;
  let insideString = false;
  let escaped = false;

  for (const character of serialized) {
    if (insideString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') insideString = false;
      continue;
    }
    if (character === '"') insideString = true;
    else if (character === '{' || character === '[') {
      depth += 1;
      if (depth > maximumDepth) return true;
    } else if (character === '}' || character === ']') depth -= 1;
  }
  return false;
}
