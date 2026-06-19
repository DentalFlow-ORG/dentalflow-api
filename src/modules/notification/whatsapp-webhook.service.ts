import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';

type WhatsAppStatus = {
  id?: string;
  status?: string;
  timestamp?: string;
  errors?: Array<{ title?: string; message?: string }>;
};

type NormalizedEvent =
  | { type: 'message' }
  | { type: 'status'; status: string; update: WhatsAppStatus };

@Injectable()
export class WhatsAppWebhookService {
  private readonly logger = new Logger(WhatsAppWebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  verify(mode?: string, token?: string, challenge?: string): string {
    const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;
    const isValid =
      mode === 'subscribe' &&
      Boolean(expectedToken) &&
      Boolean(token) &&
      Boolean(challenge) &&
      safeCompare(token ?? '', expectedToken ?? '');

    if (!isValid) {
      throw new ForbiddenException('Webhook verification failed.');
    }

    return challenge as string;
  }

  receive(payload: unknown, rawBody?: Buffer, signature?: string): void {
    this.verifySignature(rawBody, signature);

    const events = normalizeEvents(payload);
    this.logDevelopmentMetadata(events);

    const statusUpdates = events
      .filter(
        (event): event is Extract<NormalizedEvent, { type: 'status' }> =>
          event.type === 'status',
      )
      .map((event) => event.update);

    if (statusUpdates.length > 0) {
      void this.processStatusUpdates(statusUpdates).catch(() => {
        this.logger.warn('WhatsApp webhook status processing failed.');
      });
    }
  }

  private verifySignature(rawBody?: Buffer, signature?: string): void {
    const appSecret =
      process.env.WHATSAPP_APP_SECRET ??
      process.env.WHATSAPP_WEBHOOK_APP_SECRET;

    if (!appSecret) return;

    if (!rawBody || !signature) {
      throw new UnauthorizedException('Invalid webhook signature.');
    }

    const expected = `sha256=${createHmac('sha256', appSecret)
      .update(rawBody)
      .digest('hex')}`;

    if (!safeCompare(signature, expected)) {
      throw new UnauthorizedException('Invalid webhook signature.');
    }
  }

  private logDevelopmentMetadata(events: NormalizedEvent[]): void {
    if (process.env.NODE_ENV === 'production') return;

    for (const event of events) {
      if (event.type === 'status') {
        this.logger.debug(`WhatsApp webhook event: status=${event.status}`);
      } else {
        this.logger.debug('WhatsApp webhook event: message');
      }
    }
  }

  private async processStatusUpdates(
    statuses: WhatsAppStatus[],
  ): Promise<void> {
    for (const status of statuses) {
      if (!status.id || !status.status) continue;

      const data = this.mapStatusUpdate(status);
      if (!data) continue;

      await this.prisma.notificationMessage.updateMany({
        where: { providerRef: status.id },
        data,
      });
    }
  }

  private mapStatusUpdate(status: WhatsAppStatus) {
    const at = status.timestamp
      ? new Date(Number(status.timestamp) * 1000)
      : new Date();

    if (Number.isNaN(at.getTime())) return null;

    if (status.status === 'sent') {
      return { status: 'SENT' as const, sentAt: at };
    }
    if (status.status === 'delivered') {
      return { status: 'DELIVERED' as const, deliveredAt: at };
    }
    if (status.status === 'read') {
      return { status: 'READ' as const, readAt: at };
    }
    if (status.status === 'failed') {
      const reason =
        status.errors?.[0]?.title ??
        status.errors?.[0]?.message ??
        'Falha reportada pelo WhatsApp Cloud API';
      return {
        status: 'FAILED' as const,
        failedAt: at,
        failReason: reason,
      };
    }

    return null;
  }
}

function normalizeEvents(payload: unknown): NormalizedEvent[] {
  if (!isRecord(payload) || !Array.isArray(payload.entry)) return [];

  const events: NormalizedEvent[] = [];

  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;

    for (const change of entry.changes) {
      if (!isRecord(change) || !isRecord(change.value)) continue;

      if (Array.isArray(change.value.messages)) {
        for (const message of change.value.messages) {
          if (isRecord(message)) events.push({ type: 'message' });
        }
      }

      if (Array.isArray(change.value.statuses)) {
        for (const status of change.value.statuses) {
          if (!isRecord(status)) continue;

          const normalizedStatus = toStatus(status);
          events.push({
            type: 'status',
            status: normalizeStatusLabel(normalizedStatus.status),
            update: normalizedStatus,
          });
        }
      }
    }
  }

  return events;
}

function toStatus(value: Record<string, unknown>): WhatsAppStatus {
  return {
    id: typeof value.id === 'string' ? value.id : undefined,
    status: typeof value.status === 'string' ? value.status : undefined,
    timestamp:
      typeof value.timestamp === 'string' ? value.timestamp : undefined,
    errors: Array.isArray(value.errors)
      ? value.errors.filter(isRecord).map((error) => ({
          title: typeof error.title === 'string' ? error.title : undefined,
          message:
            typeof error.message === 'string' ? error.message : undefined,
        }))
      : undefined,
  };
}

function normalizeStatusLabel(status?: string): string {
  return ['sent', 'delivered', 'read', 'failed'].includes(status ?? '')
    ? (status as string)
    : 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeCompare(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}
