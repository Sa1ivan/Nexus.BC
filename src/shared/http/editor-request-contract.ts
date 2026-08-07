import type { Request } from 'express';
import { createApiHttpException } from './api-error.filter';
import { requireString, throwRequestValidationError } from './request-contract';

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const capabilityValuePattern = /^(?:4|5|4,5)$/u;

function isAscii(value: string): boolean {
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0x80) > 0x7f) return false;
  }
  return true;
}

export interface EditorCursorInput {
  readonly cursor?: string;
  readonly limit?: number;
}

export function requireUuidPath(value: string): string {
  if (!uuidPattern.test(value)) {
    throw createApiHttpException(404, 'NOT_FOUND', 'Resource not found');
  }
  return value;
}

export function requireIdempotencyKey(request: Request): string {
  const value = request.headers['idempotency-key'];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    [...value].length > 128
  ) {
    throwRequestValidationError();
  }
  return value;
}

export function requireValidClientCapabilities(request: Request): void {
  const value = request.headers['nexus-client-capabilities'];
  if (value === undefined) return;
  if (typeof value !== 'string' || !isAscii(value) || value.length > 128) {
    throwInvalidClientCapabilities();
  }
  const entries = value.split(';');
  if (entries.length !== 2) throwInvalidClientCapabilities();
  const capabilities = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator <= 0 || separator !== entry.lastIndexOf('=')) {
      throwInvalidClientCapabilities();
    }
    const key = entry.slice(0, separator);
    const versions = entry.slice(separator + 1);
    if (
      capabilities.has(key) ||
      (key !== 'site-config-read' && key !== 'site-config-write') ||
      !capabilityValuePattern.test(versions)
    ) {
      throwInvalidClientCapabilities();
    }
    capabilities.set(key, versions);
  }
  if (
    !capabilities.has('site-config-read') ||
    !capabilities.has('site-config-write')
  ) {
    throwInvalidClientCapabilities();
  }
}

function throwInvalidClientCapabilities(): never {
  throw createApiHttpException(
    400,
    'INVALID_CLIENT_CAPABILITIES',
    'Client capabilities are invalid',
  );
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

export function requireProjectName(value: unknown): string {
  const name = requireString(value);
  if (
    name.trim().length === 0 ||
    [...name].length > 256 ||
    hasControlCharacter(name)
  ) {
    throwRequestValidationError();
  }
  return name;
}

export function requireEditorPageInput(
  query: Readonly<Record<string, unknown>>,
): EditorCursorInput {
  if (Object.keys(query).some((key) => key !== 'cursor' && key !== 'limit')) {
    throwRequestValidationError();
  }
  const cursorValue = query['cursor'];
  const limitValue = query['limit'];
  const cursor =
    cursorValue === undefined
      ? undefined
      : typeof cursorValue === 'string' &&
          cursorValue.length > 0 &&
          cursorValue.length <= 2_048
        ? cursorValue
        : throwRequestValidationError();
  let limit: number | undefined;
  if (limitValue !== undefined) {
    if (typeof limitValue !== 'string' || !/^[1-9]\d*$/u.test(limitValue)) {
      throwRequestValidationError();
    }
    limit = Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit > 100) {
      throwRequestValidationError();
    }
  }
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}
