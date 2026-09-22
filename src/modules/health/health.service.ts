import { Injectable } from '@nestjs/common';
import { APP_NAME } from '../../common/constants/app.constants';
import { appConfig } from '../../config/app.config';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Probes the database and reports what it found.
   *
   * This never throws: operators need a body naming the failed dependency, not
   * an opaque error. Turning an unhealthy result into a non-2xx HTTP status is
   * the controller's job, so the diagnostic body survives on both paths.
   */
  async getStatus() {
    let db: 'connected' | 'error' = 'connected';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'error';
    }

    return {
      name: APP_NAME,
      // The API cannot serve a single tenant request without the database, so
      // it is not 'ok' when the database is unreachable.
      status: db === 'connected' ? 'ok' : 'unavailable',
      db,
      environment: appConfig.nodeEnv,
      timestamp: new Date().toISOString(),
    };
  }
}
