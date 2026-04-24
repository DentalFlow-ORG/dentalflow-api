import { Injectable } from '@nestjs/common';
import { APP_NAME } from '../../common/constants/app.constants';
import { appConfig } from '../../config/app.config';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  async getStatus() {
    let db: 'connected' | 'error' = 'connected';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'error';
    }

    return {
      name: APP_NAME,
      status: 'ok',
      db,
      environment: appConfig.nodeEnv,
      timestamp: new Date().toISOString(),
    };
  }
}
