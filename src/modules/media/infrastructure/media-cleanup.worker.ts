import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  APP_CONFIG,
  type AppConfig,
} from '../../../shared/config/app-config.schema';
import { CleanupExpiredMediaImports } from './cleanup-expired-media-imports';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;

@Injectable()
export class MediaCleanupWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(MediaCleanupWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly cleanup: CleanupExpiredMediaImports,
    @Inject(APP_CONFIG) private readonly configuration: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.configuration.nodeEnv === 'test') return;
    this.timer = setInterval(() => void this.runOnce(), CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.cleanup.execute(new Date());
    } catch {
      this.logger.error({ event: 'media_cleanup_failed' });
    } finally {
      this.running = false;
    }
  }
}
