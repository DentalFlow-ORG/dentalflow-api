import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { NOTIFICATION_PROVIDER } from './providers/notification-provider.interface';
import { LocalNotificationProvider } from './providers/local-notification.provider';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

@Module({
  imports: [PrismaModule, CommonModule],
  controllers: [NotificationController],
  providers: [
    NotificationService,
    {
      provide: NOTIFICATION_PROVIDER,
      useClass: LocalNotificationProvider,
    },
  ],
  exports: [NotificationService],
})
export class NotificationModule {}
