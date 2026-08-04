import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-ID';

interface HeaderResponse {
  getHeader(name: string): number | string | string[] | undefined;
  setHeader(name: string, value: string): unknown;
}

export function ensureResponseRequestId(response: HeaderResponse): string {
  const current = response.getHeader(REQUEST_ID_HEADER);
  if (typeof current === 'string' && current.length > 0) {
    return current;
  }

  const requestId = randomUUID();
  response.setHeader(REQUEST_ID_HEADER, requestId);
  return requestId;
}

export function createRequestIdMiddleware() {
  return (_request: Request, response: Response, next: NextFunction): void => {
    ensureResponseRequestId(response);
    next();
  };
}
