import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  type VersionedRequestFingerprint,
  versionedRequestFingerprint,
} from './idempotency-store';

const fingerprintPattern = /^hmac-sha256:v([1-9]\d*):([0-9a-f]{64})$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertUnicodeScalarSequence(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (
        index + 1 >= value.length ||
        nextCodeUnit < 0xdc00 ||
        nextCodeUnit > 0xdfff
      ) {
        throw new Error(
          'Idempotency request contains a lone Unicode surrogate',
        );
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error('Idempotency request contains a lone Unicode surrogate');
    }
  }
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    assertUnicodeScalarSequence(value);
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Idempotency request must contain finite JSON numbers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Error('Idempotency request must not be cyclic');
    }
    ancestors.add(value);
    try {
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (!isRecord(value)) {
    throw new Error('Idempotency request must be a JSON value');
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Idempotency request must contain plain JSON objects');
  }
  if (ancestors.has(value)) {
    throw new Error('Idempotency request must not be cyclic');
  }
  ancestors.add(value);
  try {
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        assertUnicodeScalarSequence(key);
        return `${JSON.stringify(key)}:${canonicalJson(value[key], ancestors)}`;
      })
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function requestDigest(request: unknown, key: Buffer): Buffer {
  const canonicalRequest = canonicalJson(request, new Set());
  return createHmac('sha256', key).update(canonicalRequest, 'utf8').digest();
}

export function createRequestFingerprint(
  request: unknown,
  activeVersion: number,
  keyring: ReadonlyMap<number, Buffer>,
): VersionedRequestFingerprint {
  const key = keyring.get(activeVersion);
  if (key === undefined) {
    throw new Error('Active idempotency fingerprint key is unavailable');
  }
  return versionedRequestFingerprint(
    `hmac-sha256:v${activeVersion}:${requestDigest(request, key).toString('hex')}`,
  );
}

export function verifyRequestFingerprint(
  fingerprint: string,
  request: unknown,
  keyring: ReadonlyMap<number, Buffer>,
): boolean {
  const match = fingerprintPattern.exec(fingerprint);
  if (match === null) return false;
  const versionValue = match[1];
  const digestValue = match[2];
  if (versionValue === undefined || digestValue === undefined) return false;
  const version = Number(versionValue);
  if (!Number.isSafeInteger(version)) return false;
  const key = keyring.get(version);
  if (key === undefined) return false;
  const expected = requestDigest(request, key);
  const supplied = Buffer.from(digestValue, 'hex');
  return (
    supplied.byteLength === expected.byteLength &&
    timingSafeEqual(supplied, expected)
  );
}
