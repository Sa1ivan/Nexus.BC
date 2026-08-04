import { Inject, Module, RequestMethod } from '@nestjs/common';
import { AuthModule } from './modules/auth/auth.module';
import { FormsModule } from './modules/forms/forms.module';
import { MediaModule } from './modules/media/media.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SitesModule } from './modules/sites/sites.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';
import { AppConfigModule } from './shared/config/app-config.module';
import { APP_CONFIG } from './shared/config/app-config.schema';
import { createCredentialedCorsMiddleware } from './shared/http/credentialed-cors.middleware';
import type { CorsConfiguration } from './shared/http/credentialed-cors.middleware';

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
})
export class AppModule {
  constructor(
    @Inject(APP_CONFIG) private readonly configuration: CorsConfiguration,
  ) {}

  configure(consumer: MiddlewareRouteConsumer): void {
    consumer
      .apply(createCredentialedCorsMiddleware(this.configuration))
      .forRoutes({
        path: '*',
        method: RequestMethod.ALL,
      });
  }
}
