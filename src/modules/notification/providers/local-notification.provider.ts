import { Injectable, Logger } from '@nestjs/common';
import type { INotificationProvider, SendPayload, SendResult } from './notification-provider.interface';

@Injectable()
export class LocalNotificationProvider implements INotificationProvider {
  private readonly logger = new Logger(LocalNotificationProvider.name);

  async send(payload: SendPayload): Promise<SendResult> {
    const phone = maskPhone(payload.phone);
    this.logger.log(
      `[SIMULATED] WhatsApp -> ${phone} | template: ${payload.templateSlug} | appt: ${payload.appointmentId ?? 'none'}`,
    );
    // No external API call — simulation only
    return { providerRef: null };
  }
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `***${digits.slice(-4)}`;
}
