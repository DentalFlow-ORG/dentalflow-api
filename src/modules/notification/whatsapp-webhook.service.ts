import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';

type WhatsAppError = {
  code?: string;
  title?: string;
  message?: string;
  details?: string;
  href?: string;
};

type WhatsAppStatus = {
  id?: string;
  status?: string;
  timestamp?: string;
  errors?: WhatsAppError[];
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

  receive(
    payload: unknown,
    rawBody?: Buffer,
    signature?: string,
  ): Promise<void> {
    this.verifySignature(rawBody, signature);

    const events = normalizeEvents(payload);
    this.logReceiptMetadata(payload, events);

    const statusUpdates = events
      .filter(
        (event): event is Extract<NormalizedEvent, { type: 'status' }> =>
          event.type === 'status',
      )
      .map((event) => event.update);

    return this.processStatusUpdates(statusUpdates);
  }

  private verifySignature(rawBody?: Buffer, signature?: string): void {
    const appSecret =
      process.env.WHATSAPP_APP_SECRET ??
      process.env.WHATSAPP_WEBHOOK_APP_SECRET;

    if (!appSecret) {
      if (process.env.NODE_ENV === 'production') {
        throw new UnauthorizedException(
          'Webhook signature verification is not configured.',
        );
      }
      return;
    }

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

  private logReceiptMetadata(
    payload: unknown,
    events: NormalizedEvent[],
  ): void {
    const objectType =
      isRecord(payload) && isSafeMetadataLabel(payload.object)
        ? payload.object
        : 'unknown';
    const entries =
      isRecord(payload) && Array.isArray(payload.entry) ? payload.entry : [];
    const fields = collectSafeFieldNames(entries);
    const statuses = events.filter((event) => event.type === 'status');
    const messages = events.filter((event) => event.type === 'message');
    const statusValues = [...new Set(statuses.map((event) => event.status))];

    this.logger.log(
      `WhatsApp webhook received: object=${objectType} entries=${entries.length} ` +
        `fields=${fields.length > 0 ? fields.join(',') : 'none'} ` +
        `statuses=${statuses.length} messages=${messages.length} ` +
        `statusValues=${statusValues.length > 0 ? statusValues.join(',') : 'none'}`,
    );

    this.logFailedStatusMetadata(statuses);
  }

  private logFailedStatusMetadata(
    statuses: Extract<NormalizedEvent, { type: 'status' }>[],
  ): void {
    for (const event of statuses) {
      if (event.status !== 'failed') continue;

      const errors = event.update.errors ?? [];
      const errorsWithMetadata = errors.filter(hasErrorMetadata);

      if (errorsWithMetadata.length === 0) {
        this.logger.warn('WhatsApp webhook failed status: no error metadata');
        continue;
      }

      for (const error of errorsWithMetadata) {
        this.logger.warn(
          `WhatsApp webhook failed status: code=${error.code ?? 'unknown'} ` +
            `title=${quoteSafeText(error.title)} ` +
            `message=${quoteSafeText(error.message)} ` +
            `details=${quoteSafeText(error.details)} ` +
            `href=${quoteSafeText(sanitizeErrorHref(error.href))}`,
        );
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
      ? value.errors.filter(isRecord).map(toWhatsAppError)
      : undefined,
  };
}

function toWhatsAppError(error: Record<string, unknown>): WhatsAppError {
  const errorData = isRecord(error.error_data) ? error.error_data : undefined;

  return {
    code: normalizeErrorCode(error.code),
    title: sanitizeErrorText(error.title),
    message: sanitizeErrorText(error.message),
    details: sanitizeErrorText(errorData?.details),
    href: sanitizeErrorHref(error.href),
  };
}

function normalizeStatusLabel(status?: string): string {
  return ['sent', 'delivered', 'read', 'failed'].includes(status ?? '')
    ? (status as string)
    : 'unknown';
}

function collectSafeFieldNames(entries: unknown[]): string[] {
  const fields = new Set<string>();

  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;

    for (const change of entry.changes) {
      if (isRecord(change) && isSafeMetadataLabel(change.field)) {
        fields.add(change.field);
      }
    }
  }

  return [...fields];
}

function isSafeMetadataLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^[a-zA-Z0-9_.-]+$/.test(value)
  );
}

function normalizeErrorCode(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }

  return isSafeMetadataLabel(value) ? value : undefined;
}

function sanitizeErrorText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;

  const sanitized = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\+?\d[\d\s().-]{5,}\d/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);

  return sanitized || undefined;
}

function sanitizeErrorHref(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return undefined;
    }

    return sanitizeErrorText(`${url.origin}${url.pathname}`);
  } catch {
    return undefined;
  }
}

function quoteSafeText(value?: string): string {
  return JSON.stringify(value ?? 'none');
}

function hasErrorMetadata(error: WhatsAppError): boolean {
  return Boolean(
    error.code || error.title || error.message || error.details || error.href,
  );
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
