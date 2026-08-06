import {
  Body,
  Controller,
  Post,
  Req,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request as ExpressRequest } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { SITE_CONFIG_V4_JSON_ENVELOPE_BYTES_LIMIT } from '../../src/modules/sites/domain/site-config-v4';
import {
  createHttpJsonParserMiddleware,
  requestRawJsonBody,
} from '../../src/shared/http/http-json-parser';

@Controller('__test/json-parser')
class JsonParserProbeController {
  @Post()
  parse(
    @Req() requestValue: ExpressRequest,
    @Body() body: unknown,
  ): { readonly body: unknown; readonly rawBytes: number } {
    return {
      body,
      rawBytes: Buffer.byteLength(requestRawJsonBody(requestValue)),
    };
  }
}

describe('bounded HTTP JSON parser', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      controllers: [JsonParserProbeController],
    }).compile();
    const nestApp = moduleFixture.createNestApplication<NestExpressApplication>(
      { bodyParser: false },
    );
    nestApp.useLogger(false);
    nestApp.use(createHttpJsonParserMiddleware());
    await nestApp.init();
    app = nestApp;
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts and retains an exact 1,310,720-byte JSON envelope', async () => {
    const base = '{"value":1}';
    const serialized = `${base}${' '.repeat(
      SITE_CONFIG_V4_JSON_ENVELOPE_BYTES_LIMIT - Buffer.byteLength(base),
    )}`;

    const response = await request(app.getHttpServer())
      .post('/__test/json-parser')
      .set('Content-Type', 'application/json')
      .send(serialized)
      .expect(201);

    expect(response.body).toEqual({
      body: { value: 1 },
      rawBytes: SITE_CONFIG_V4_JSON_ENVELOPE_BYTES_LIMIT,
    });
  });

  it('rejects the first byte over the JSON envelope limit', async () => {
    const base = '{"value":1}';
    const serialized = `${base}${' '.repeat(
      SITE_CONFIG_V4_JSON_ENVELOPE_BYTES_LIMIT + 1 - Buffer.byteLength(base),
    )}`;

    await request(app.getHttpServer())
      .post('/__test/json-parser')
      .set('Content-Type', 'application/json')
      .send(serialized)
      .expect(413);
  });

  it('accepts depth 32 and rejects depth 33 before the controller', async () => {
    const depth32 = `${'{"nested":'.repeat(32)}null${'}'.repeat(32)}`;
    const depth33 = `${'{"nested":'.repeat(33)}null${'}'.repeat(33)}`;

    await request(app.getHttpServer())
      .post('/__test/json-parser')
      .set('Content-Type', 'application/json')
      .send(depth32)
      .expect(201);
    await request(app.getHttpServer())
      .post('/__test/json-parser')
      .set('Content-Type', 'application/json')
      .send(depth33)
      .expect(400);
  });
});
