import { Injectable, Logger } from '@nestjs/common';
import type { INotificationProvider, SendPayload, SendResult } from './notification-provider.interface';

@Injectable()
export class LocalNotificationProvider implements INotificationProvider {
  private readonly logger = new Logger(LocalNotificationProvider.name);

  async send(payload: SendPayload): Promise<SendResult> {
    this.logger.log(
      `[SIMULATED] WhatsApp → +55${payload.phone} | template: ${payload.templateSlug} | appt: ${payload.appointmentId ?? 'none'}`,
    );
    // No external API call — simulation only
    return { providerRef: null };
  }
}
