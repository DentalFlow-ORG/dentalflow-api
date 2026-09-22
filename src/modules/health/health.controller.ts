import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Readiness probe. Returns 503 when the database is unreachable so that
   * uptime monitors and load balancers, which look at the HTTP status rather
   * than the body, cannot report a healthy API during a database outage.
   * The body is unchanged either way, so existing consumers keep working.
   */
  @Public()
  @Get()
  async getStatus() {
    const status = await this.healthService.getStatus();

    if (status.db !== 'connected') {
      throw new ServiceUnavailableException(status);
    }

    return status;
  }
}
