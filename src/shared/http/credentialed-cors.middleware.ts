import type { NextFunction, Request, Response } from 'express';

export interface CorsConfiguration {
  readonly webOrigins: readonly string[];
}

const allowedMethods = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const allowedHeaders =
  'Authorization, Content-Type, Idempotency-Key, Nexus-Client-Capabilities';

export function createCredentialedCorsMiddleware(
  configuration: CorsConfiguration,
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    response.vary('Origin');
    const origin = request.headers.origin;
    if (origin === undefined) {
      next();
      return;
    }

    if (!configuration.webOrigins.includes(origin)) {
      response.status(403).json({
        error: {
          code: 'CORS_ORIGIN_DENIED',
          message: 'The request origin is not allowed',
        },
      });
      return;
    }

    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Credentials', 'true');

    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', allowedMethods);
      response.setHeader('Access-Control-Allow-Headers', allowedHeaders);
      response.status(204).send();
      return;
    }

    next();
  };
}
