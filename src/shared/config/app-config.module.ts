import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadAppConfig } from './app-config.schema';

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: loadAppConfig }],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
