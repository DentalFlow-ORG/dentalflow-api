import {
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import { WhatsAppWebhookService } from './whatsapp-webhook.service';

@Controller('webhooks/whatsapp')
@Public()
export class WhatsAppWebhookController {
  constructor(private readonly webhookService: WhatsAppWebhookService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/plain')
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') token?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    return this.webhookService.verify(mode, token, challenge);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature?: string,
  ): { status: 'ok' } {
    this.webhookService.receive(req.body, req.rawBody, signature);
    return { status: 'ok' };
  }
}
