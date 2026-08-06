import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APP_CONFIG } from './shared/config/app-config.schema';

interface PortConfiguration {
  readonly port: number;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.enableShutdownHooks();
  const configuration = app.get<PortConfiguration>(APP_CONFIG);
  await app.listen(configuration.port);
}

void bootstrap();
