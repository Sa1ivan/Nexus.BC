import { isIP } from 'node:net';
import type { Request } from 'express';
import type { NodeEnvironment } from '../config/app-config.schema';
import { createApiHttpException } from './api-error.filter';

export function throwRequestValidationError(): never {
  throw createApiHttpException(
    400,
    'VALIDATION_ERROR',
    'Request validation failed',
  );
}

export function exactRequestBody(
  body: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).sort().join(',') !== [...keys].sort().join(',')
  ) {
    throwRequestValidationError();
  }
  return body as Readonly<Record<string, unknown>>;
}

export function requireBoundedString(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): string {
  const stringValue = requireString(value);
  if (
    stringValue.length < minimumLength ||
    stringValue.length > maximumLength
  ) {
    throwRequestValidationError();
  }
  return stringValue;
}

export function requireString(value: unknown): string {
  if (typeof value !== 'string') {
    throwRequestValidationError();
  }
  return value;
}

function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value !== 'string' || value.includes(',')) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}

function isPrivateIngressAddress(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const withoutZone = value.split('%')[0] ?? value;
  const normalized = withoutZone.startsWith('::ffff:')
    ? withoutZone.slice('::ffff:'.length)
    : withoutZone;
  if (isIP(normalized) === 4) {
    const octets = normalized.split('.').map(Number);
    const first = octets[0] ?? -1;
    const second = octets[1] ?? -1;
    return (
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  const lower = normalized.toLowerCase();
  return (
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    /^fe[89ab][0-9a-f]:/u.test(lower)
  );
}

function isTrustedRailwayIngress(request: Request): boolean {
  const edge = singleHeader(request.headers['x-railway-edge']);
  const requestId = singleHeader(request.headers['x-railway-request-id']);
  const requestStartedAt = singleHeader(request.headers['x-request-start']);
  return (
    isPrivateIngressAddress(request.socket.remoteAddress) &&
    request.headers['x-forwarded-proto'] === 'https' &&
    edge !== undefined &&
    /^[a-z]{3}\d+$/iu.test(edge) &&
    requestId !== undefined &&
    /^[a-z0-9_-]{8,256}$/iu.test(requestId) &&
    requestStartedAt !== undefined &&
    /^\d{10,16}$/u.test(requestStartedAt)
  );
}

export function requestClientIp(
  request: Request,
  nodeEnvironment: NodeEnvironment,
): string {
  if (nodeEnvironment === 'production' && isTrustedRailwayIngress(request)) {
    const railwayClientIp = singleHeader(request.headers['x-real-ip']);
    if (railwayClientIp !== undefined && isIP(railwayClientIp) !== 0) {
      return railwayClientIp;
    }
  }
  return request.socket.remoteAddress || 'unknown';
}

export function requireAllowedOrigin(
  request: Request,
  allowedOrigins: readonly string[],
): void {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !allowedOrigins.includes(origin)) {
    throw createApiHttpException(403, 'ORIGIN_REQUIRED', 'Origin is required');
  }
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) {
    return undefined;
  }
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (pair.slice(0, separator).trim() === name) {
      const value = pair.slice(separator + 1).trim();
      return value.length === 0 ? undefined : value;
    }
  }
  return undefined;
}

export function serializeSecureHttpOnlyCookie(input: {
  readonly maxAgeSeconds: number;
  readonly name: string;
  readonly path: string;
  readonly value: string;
}): string {
  return `${input.name}=${input.value}; Max-Age=${input.maxAgeSeconds}; Path=${input.path}; HttpOnly; Secure; SameSite=Lax`;
}
