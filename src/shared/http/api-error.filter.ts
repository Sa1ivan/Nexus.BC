import { HttpException, HttpStatus, type ArgumentsHost } from '@nestjs/common';
import type { Response } from 'express';
import { ensureResponseRequestId } from './request-id.middleware';

interface ErrorContract {
  readonly code: string;
  readonly message: string;
}

type PublicDetailValue = boolean | number | string | null;
type PublicErrorDetails = Readonly<Record<string, PublicDetailValue>>;

interface PublicErrorContract extends ErrorContract {
  readonly details?: PublicErrorDetails;
}

interface ClassifiedError extends ErrorContract {
  readonly status: number;
  readonly details?: unknown;
}

const errorsByStatus: Readonly<Partial<Record<number, ErrorContract>>> = {
  [HttpStatus.BAD_REQUEST]: {
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed',
  },
  [HttpStatus.UNAUTHORIZED]: {
    code: 'AUTHENTICATION_REQUIRED',
    message: 'Authentication required',
  },
  [HttpStatus.FORBIDDEN]: {
    code: 'FORBIDDEN',
    message: 'Access denied',
  },
  [HttpStatus.NOT_FOUND]: {
    code: 'NOT_FOUND',
    message: 'Resource not found',
  },
  [HttpStatus.CONFLICT]: {
    code: 'CONFLICT',
    message: 'Request conflicts with current state',
  },
  [HttpStatus.TOO_MANY_REQUESTS]: {
    code: 'RATE_LIMITED',
    message: 'Too many requests',
  },
};

const internalServerError: ErrorContract = {
  code: 'INTERNAL_SERVER_ERROR',
  message: 'Internal server error',
};

class TrustedApiHttpException extends HttpException {
  constructor(
    status: number,
    readonly contract: PublicErrorContract,
  ) {
    super(contract, status);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function classifyHttpException(exception: HttpException): ClassifiedError {
  const status = exception.getStatus();
  if (status >= 500) {
    return { status, ...internalServerError };
  }

  if (exception instanceof TrustedApiHttpException) {
    return { status, ...exception.contract };
  }

  const statusContract = errorsByStatus[status];
  if (statusContract) {
    return { status, ...statusContract };
  }

  return {
    status,
    code: 'HTTP_ERROR',
    message: 'Request failed',
  };
}

function classifyError(exception: unknown): ClassifiedError {
  return exception instanceof HttpException
    ? classifyHttpException(exception)
    : { status: HttpStatus.INTERNAL_SERVER_ERROR, ...internalServerError };
}

export function createApiHttpException(
  status: number,
  code: string,
  message: string,
  details?: PublicErrorDetails,
) {
  if (!Number.isInteger(status) || status < 400 || status >= 500) {
    throw new TypeError('Public API exceptions require a 4xx status');
  }
  if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]*$/u.test(code)) {
    throw new TypeError('Public API error codes must use uppercase snake case');
  }
  if (typeof message !== 'string' || message.length === 0) {
    throw new TypeError('Public API error messages must not be empty');
  }
  if (
    details !== undefined &&
    (!isRecord(details) ||
      Object.values(details).some(
        (value) =>
          value !== null &&
          typeof value !== 'boolean' &&
          typeof value !== 'number' &&
          typeof value !== 'string',
      ))
  ) {
    throw new TypeError(
      'Public API error details must contain flat primitives',
    );
  }

  const contract: PublicErrorContract = {
    code,
    message,
    ...(details === undefined
      ? {}
      : { details: Object.freeze({ ...details }) }),
  };
  return new TrustedApiHttpException(status, Object.freeze(contract));
}

export function createApiErrorFilter() {
  return {
    catch(exception: unknown, host: ArgumentsHost): void {
      const response = host.switchToHttp().getResponse<Response>();
      const requestId = ensureResponseRequestId(response);
      const classified = classifyError(exception);
      const error = {
        code: classified.code,
        message: classified.message,
        requestId,
        ...('details' in classified ? { details: classified.details } : {}),
      };

      response.status(classified.status).json({ error });
    },
  };
}
