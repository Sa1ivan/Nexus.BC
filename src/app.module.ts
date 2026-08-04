import { Inject, Module, RequestMethod } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './modules/auth/auth.module';
import { FormsModule } from './modules/forms/forms.module';
import { MediaModule } from './modules/media/media.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SitesModule } from './modules/sites/sites.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';
import { AppConfigModule } from './shared/config/app-config.module';
import { APP_CONFIG } from './shared/config/app-config.schema';
import { createApiErrorFilter } from './shared/http/api-error.filter';
import { createCredentialedCorsMiddleware } from './shared/http/credentialed-cors.middleware';
import type { CorsConfiguration } from './shared/http/credentialed-cors.middleware';
import { createRequestIdMiddleware } from './shared/http/request-id.middleware';

interface MiddlewareRouteConsumer {
  apply(...middleware: unknown[]): {
    forRoutes(...routes: unknown[]): unknown;
  };
}

@Module({
  imports: [
    AppConfigModule,
    AuthModule,
    WorkspacesModule,
    SitesModule,
    MediaModule,
    FormsModule,
    NotificationsModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useFactory: createApiErrorFilter,
    },
  ],
})
export class AppModule {
  constructor(
    @Inject(APP_CONFIG) private readonly configuration: CorsConfiguration,
  ) {}

  configure(consumer: MiddlewareRouteConsumer): void {
    consumer
      .apply(
        createRequestIdMiddleware(),
        createCredentialedCorsMiddleware(this.configuration),
      )
      .forRoutes({
        path: '*',
        method: RequestMethod.ALL,
      });
  }
}
