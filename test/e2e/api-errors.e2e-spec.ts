import {
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  type INestApplication,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { createApiHttpException } from '../../src/shared/http/api-error.filter';

interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
  readonly details?: unknown;
}

@Controller('__test/errors')
class ErrorProbeController {
  @Get('validation')
  validation(): never {
    throw new BadRequestException({
      error: 'Bad Request',
      message: ['password must not equal super-secret'],
      statusCode: HttpStatus.BAD_REQUEST,
    });
  }

  @Get('authentication')
  authentication(): never {
    throw new UnauthorizedException();
  }

  @Get('authorization')
  authorization(): never {
    throw new ForbiddenException();
  }

  @Get('conflict')
  conflict(): never {
    throw new ConflictException();
  }

  @Get('domain-conflict')
  domainConflict(): never {
    throw createApiHttpException(
      HttpStatus.CONFLICT,
      'PROJECT_VERSION_CONFLICT',
      'The project draft version is stale',
      { expectedVersion: 4 },
    );
  }

  @Get('untrusted-contract')
  untrustedContract(): never {
    const cyclicDetails: Record<string, unknown> = {
      connectionToken: 'secret-token',
    };
    cyclicDetails['self'] = cyclicDetails;
    throw new ConflictException({
      code: 'PROJECT_VERSION_CONFLICT',
      message: 'token=secret-token',
      details: cyclicDetails,
    });
  }

  @Get('rate-limit')
  rateLimit(): never {
    throw new HttpException('provider detail must not escape', 429);
  }

  @Get('unexpected')
  unexpected(): never {
    throw new Error('database password=super-secret');
  }

  @Get('explicit-internal')
  explicitInternal(): never {
    throw new HttpException(
      {
        code: 'DATABASE_FAILURE',
        message: 'database password=super-secret',
        details: { connectionToken: 'secret-token' },
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('invalid-public-contract')
  invalidPublicContract(): never {
    const unsafeCreate = createApiHttpException as unknown as (
      status: number,
      code: unknown,
      message: unknown,
    ) => HttpException;
    throw unsafeCreate(
      HttpStatus.CONFLICT,
      { toString: () => 'PROJECT_VERSION_CONFLICT' },
      { connectionToken: 'secret-token' },
    );
  }

  @Post('body')
  body(): { readonly ok: true } {
    return { ok: true };
  }
}

function readErrorBody(response: request.Response): ErrorBody {
  const body: unknown = response.body;
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    throw new Error('Expected one top-level error envelope');
  }
  if (Object.keys(body).length !== 1) {
    throw new Error('Expected no fields beside the error envelope');
  }

  const error: unknown = body.error;
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    typeof error.code !== 'string' ||
    !('message' in error) ||
    typeof error.message !== 'string' ||
    !('requestId' in error) ||
    typeof error.requestId !== 'string'
  ) {
    throw new Error('Expected a typed API error body');
  }

  return error;
}

function expectRequestId(response: request.Response, error: ErrorBody): void {
  expect(error.requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  expect(response.headers['x-request-id']).toBe(error.requestId);
}

describe('API error contract', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ErrorProbeController],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('maps validation errors without forwarding validator messages', async () => {
    const response = await request(app.getHttpServer())
      .get('/__test/errors/validation')
      .expect(HttpStatus.BAD_REQUEST);
    const error = readErrorBody(response);

    expect(error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
    });
    expect(error).not.toHaveProperty('details');
    expect(JSON.stringify(response.body)).not.toContain('super-secret');
    expectRequestId(response, error);
  });

  it.each([
    [
      'authentication',
      '/__test/errors/authentication',
      HttpStatus.UNAUTHORIZED,
      'AUTHENTICATION_REQUIRED',
      'Authentication required',
    ],
    [
      'authorization',
      '/__test/errors/authorization',
      HttpStatus.FORBIDDEN,
      'FORBIDDEN',
      'Access denied',
    ],
    [
      'missing resource',
      '/__test/errors/missing',
      HttpStatus.NOT_FOUND,
      'NOT_FOUND',
      'Resource not found',
    ],
    [
      'generic conflict',
      '/__test/errors/conflict',
      HttpStatus.CONFLICT,
      'CONFLICT',
      'Request conflicts with current state',
    ],
    [
      'rate limit',
      '/__test/errors/rate-limit',
      HttpStatus.TOO_MANY_REQUESTS,
      'RATE_LIMITED',
      'Too many requests',
    ],
  ])(
    'maps %s responses to the stable envelope',
    async (_label, path, status, code, message) => {
      const response = await request(app.getHttpServer())
        .get(path)
        .expect(status);
      const error = readErrorBody(response);

      expect(error).toMatchObject({ code, message });
      expect(error).not.toHaveProperty('details');
      expectRequestId(response, error);
    },
  );

  it('preserves an explicit domain conflict contract', async () => {
    const response = await request(app.getHttpServer())
      .get('/__test/errors/domain-conflict')
      .expect(HttpStatus.CONFLICT);
    const error = readErrorBody(response);

    expect(error).toMatchObject({
      code: 'PROJECT_VERSION_CONFLICT',
      message: 'The project draft version is stale',
      details: { expectedVersion: 4 },
    });
    expectRequestId(response, error);
  });

  it('does not trust an arbitrary HttpException public contract', async () => {
    const response = await request(app.getHttpServer())
      .get('/__test/errors/untrusted-contract')
      .expect(HttpStatus.CONFLICT);
    const error = readErrorBody(response);
    const serializedBody = JSON.stringify(response.body);

    expect(error).toMatchObject({
      code: 'CONFLICT',
      message: 'Request conflicts with current state',
    });
    expect(error).not.toHaveProperty('details');
    expect(serializedBody).not.toContain('secret-token');
    expectRequestId(response, error);
  });

  it('hides unexpected exception messages, stacks, and secret-bearing details', async () => {
    const response = await request(app.getHttpServer())
      .get('/__test/errors/unexpected')
      .expect(HttpStatus.INTERNAL_SERVER_ERROR);
    const error = readErrorBody(response);
    const serializedBody = JSON.stringify(response.body);

    expect(error).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    });
    expect(error).not.toHaveProperty('details');
    expect(serializedBody).not.toContain('super-secret');
    expect(serializedBody.toLowerCase()).not.toContain('stack');
    expectRequestId(response, error);
  });

  it('does not trust an explicit contract attached to an internal error', async () => {
    const response = await request(app.getHttpServer())
      .get('/__test/errors/explicit-internal')
      .expect(HttpStatus.INTERNAL_SERVER_ERROR);
    const error = readErrorBody(response);
    const serializedBody = JSON.stringify(response.body);

    expect(error).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    });
    expect(error).not.toHaveProperty('details');
    expect(serializedBody).not.toContain('super-secret');
    expect(serializedBody).not.toContain('secret-token');
    expectRequestId(response, error);
  });

  it('rejects non-string fields at the public error factory boundary', async () => {
    const response = await request(app.getHttpServer())
      .get('/__test/errors/invalid-public-contract')
      .expect(HttpStatus.INTERNAL_SERVER_ERROR);
    const error = readErrorBody(response);
    const serializedBody = JSON.stringify(response.body);

    expect(error).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    });
    expect(serializedBody).not.toContain('secret-token');
    expectRequestId(response, error);
  });

  it('normalizes malformed JSON rejected by the HTTP adapter', async () => {
    const response = await request(app.getHttpServer())
      .post('/__test/errors/body')
      .set('Content-Type', 'application/json')
      .send('{"broken":')
      .expect(HttpStatus.BAD_REQUEST);
    const error = readErrorBody(response);

    expect(error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
    });
    expectRequestId(response, error);
  });

  it('adds the stable envelope to CORS denials before the exception filter', async () => {
    const response = await request(app.getHttpServer())
      .get('/__test/errors/missing')
      .set('Origin', 'https://foreign.example')
      .expect(HttpStatus.FORBIDDEN);
    const error = readErrorBody(response);

    expect(error).toMatchObject({
      code: 'CORS_ORIGIN_DENIED',
      message: 'The request origin is not allowed',
    });
    expectRequestId(response, error);
  });
});
