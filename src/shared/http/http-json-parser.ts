import { BadRequestException } from '@nestjs/common';
import { json } from 'express';
import type { Request as ExpressRequest, RequestHandler } from 'express';

const JSON_ENVELOPE_BYTES_LIMIT = 1_310_720;
const MAX_JSON_DEPTH = 32;

const rawJsonBodies = new WeakMap<object, string>();

export function createHttpJsonParserMiddleware(): RequestHandler {
  return json({
    limit: JSON_ENVELOPE_BYTES_LIMIT,
    verify: (request, _response, buffer) => {
      const serialized = buffer.toString('utf8');
      if (exceedsJsonDepth(serialized, MAX_JSON_DEPTH)) {
        throw new BadRequestException('JSON nesting depth exceeds the limit');
      }
      rawJsonBodies.set(request, serialized);
    },
  });
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
    } else if (character === '}' || character === ']') {
      depth -= 1;
    }
  }
  return false;
}

export function requestRawJsonBody(request: ExpressRequest): string {
  return rawJsonBodies.get(request) ?? '';
}
