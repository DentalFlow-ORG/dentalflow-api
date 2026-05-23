import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  RawBodyRequest,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';

type WhatsAppStatus = {
  id?: string;
  status?: 'sent' | 'delivered' | 'read' | 'failed' | string;
  timestamp?: string;
  errors?: Array<{ title?: string; message?: string; code?: number }>;
};

type WhatsAppWebhookBody = {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: {
        statuses?: WhatsAppStatus[];
      };
    }>;
  }>;
};

@Controller('notifications/whatsapp/webhook')
@Public()
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const expectedToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

    if (mode !== 'subscribe' || token !== expectedToken) {
      throw new BadRequestException('Webhook verification failed.');
    }

    res.setHeader('Content-Type', 'text/plain');
    res.send(challenge);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  receive(@Req() req: RawBodyRequest<Request>): { status: string } {
    const appSecret = process.env.WHATSAPP_WEBHOOK_APP_SECRET;
    const signature = req.headers['x-hub-signature-256'] as string | undefined;

    if (appSecret && signature) {
      const rawBody = req.rawBody;
      if (!rawBody) {
        throw new BadRequestException('Raw body not available.');
      }

      const expected =
        'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');

      if (!safeCompare(signature, expected)) {
        this.logger.warn('WhatsApp webhook signature mismatch - request rejected');
        throw new UnauthorizedException('Assinatura de webhook invalida.');
      }
    }

    const body = req.body as WhatsAppWebhookBody;
    if (body.object === 'whatsapp_business_account') {
      void this.processStatusUpdates(body);
      this.logger.log(
        `WhatsApp webhook event received: ${body.entry?.length ?? 0} entries`,
      );
    }

    return { status: 'ok' };
  }

  private async processStatusUpdates(body: WhatsAppWebhookBody): Promise<void> {
    const statuses =
      body.entry?.flatMap((entry) =>
        entry.changes?.flatMap((change) => change.value?.statuses ?? []) ?? [],
      ) ?? [];

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
      return { status: 'FAILED' as const, failedAt: at, failReason: reason };
    }

    return null;
  }
}

function safeCompare(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}
