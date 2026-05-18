import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { NOTIFICATION_PROVIDER } from './providers/notification-provider.interface';
import { LocalNotificationProvider } from './providers/local-notification.provider';
import { WhatsAppCloudProvider } from './providers/whatsapp-cloud.provider';
import { NotificationController } from './notification.controller';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';
import { NotificationService } from './notification.service';

@Module({
  imports: [PrismaModule, CommonModule],
  controllers: [NotificationController, WhatsAppWebhookController],
  providers: [
    NotificationService,
    WhatsAppCloudProvider,
    {
      provide: NOTIFICATION_PROVIDER,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => {
        const providerEnv = process.env.NOTIFICATION_PROVIDER ?? 'local';
        const cloudEnabled = process.env.WHATSAPP_CLOUD_API_ENABLED === 'true';
        if (providerEnv === 'whatsapp_cloud' && cloudEnabled) {
          return new WhatsAppCloudProvider(prisma);
        }
        return new LocalNotificationProvider();
      },
    },
  ],
  exports: [NotificationService],
})
export class NotificationModule {}
