import { Controller, Get, Header, Inject } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.schema';
import { siteConfigRolloutHandlers } from '../config/site-config-rollout';
import type { SiteConfigCapabilities } from '../config/site-config-rollout';
import { Public } from './public.decorator';

export interface ApiCapabilitiesDto {
  readonly siteConfig: SiteConfigCapabilities;
}

@Public()
@Controller('v1/capabilities')
export class CapabilitiesController {
  constructor(
    @Inject(APP_CONFIG)
    private readonly configuration: Pick<AppConfig, 'siteConfigRolloutMode'>,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(): ApiCapabilitiesDto {
    return {
      siteConfig:
        siteConfigRolloutHandlers[this.configuration.siteConfigRolloutMode]
          .capabilities,
    };
  }
}
