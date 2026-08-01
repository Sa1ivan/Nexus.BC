import { Module } from '@nestjs/common';
import { AuthModule } from './modules/auth/auth.module';
import { FormsModule } from './modules/forms/forms.module';
import { MediaModule } from './modules/media/media.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SitesModule } from './modules/sites/sites.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';

@Module({
  imports: [
    AuthModule,
    WorkspacesModule,
    SitesModule,
    MediaModule,
    FormsModule,
    NotificationsModule,
  ],
})
export class AppModule {}
