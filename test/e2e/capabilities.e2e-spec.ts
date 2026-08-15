import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { APP_CONFIG } from '../../src/shared/config/app-config.schema';
import type { SiteConfigRolloutMode } from '../../src/shared/config/app-config.schema';
import { CapabilitiesController } from '../../src/shared/http/capabilities.controller';

describe.each([
  [
    'V4_COMPAT',
    {
      rolloutMode: 'V4_COMPAT',
      readVersions: [4, 5],
      acceptedInputVersions: [4],
      writeVersion: 4,
    },
  ],
  [
    'V5_ACTIVE',
    {
      rolloutMode: 'V5_ACTIVE',
      readVersions: [4, 5],
      acceptedInputVersions: [4, 5],
      writeVersion: 5,
    },
  ],
] as const)('API capabilities in %s', (rolloutMode, expectedSiteConfig) => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      controllers: [CapabilitiesController],
      providers: [
        {
          provide: APP_CONFIG,
          useValue: {
            siteConfigRolloutMode: rolloutMode satisfies SiteConfigRolloutMode,
          },
        },
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the exact no-store rollout tuple', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/capabilities')
      .expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({ siteConfig: expectedSiteConfig });
  });
});
