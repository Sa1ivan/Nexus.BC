import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DATABASE_READINESS,
  type DatabaseReadiness,
} from '../database/database-readiness';
import { Public } from '../http/public.decorator';

@Public()
@Controller('v1/health')
export class HealthController {
  constructor(
    @Inject(DATABASE_READINESS)
    private readonly databaseReadiness: DatabaseReadiness,
  ) {}

  @Get('live')
  live(): { readonly status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ readonly status: 'ok' }> {
    if (!(await this.databaseReadiness.isReady())) {
      throw new ServiceUnavailableException();
    }
    return { status: 'ok' };
  }
}
