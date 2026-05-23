import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  RawBody,
} from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { WebhookService } from './webhook.service';

@Controller('billing')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  /**
   * Stripe calls this endpoint directly — no JWT, no tenant guard.
   * Security is provided by Stripe signature verification inside WebhookService.
   */
  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @RawBody() rawBody: Buffer,
    @Headers('stripe-signature') signature: string,
  ): Promise<{ received: boolean }> {
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }
    await this.webhookService.handleWebhook(rawBody, signature);
    return { received: true };
  }
}
