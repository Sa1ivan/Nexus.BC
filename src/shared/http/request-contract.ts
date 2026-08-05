import type { Request } from 'express';
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

export function requestClientIp(request: Request): string {
  return request.ip || request.socket.remoteAddress || 'unknown';
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
