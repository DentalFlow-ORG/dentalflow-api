import { NotificationChannel, NotificationScope } from '@prisma/client';

export interface SendPayload {
  clinicId: string;
  consentId: string | null;
  appointmentId: string | null;
  templateSlug: string;
  phone: string;
  channel: NotificationChannel;
  scope: NotificationScope;
}

export interface SendResult {
  providerRef: string | null;
}

export const NOTIFICATION_PROVIDER = Symbol('NOTIFICATION_PROVIDER');

export interface INotificationProvider {
  send(payload: SendPayload): Promise<SendResult>;
}
