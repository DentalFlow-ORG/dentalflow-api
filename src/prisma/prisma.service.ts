import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { databaseConfig } from '../config/database.config';

@Injectable()
export class PrismaService implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    if (!databaseConfig.url) {
      this.logger.warn(
        'DATABASE_URL is not configured. Prisma integration is prepared but not connected yet.',
      );
    }
  }
}
