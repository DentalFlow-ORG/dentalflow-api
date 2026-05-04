import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { StripeService } from './stripe.service';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

@Module({
  controllers: [BillingController, WebhookController],
  providers: [BillingService, StripeService, WebhookService],
  exports: [BillingService, StripeService],
})
export class BillingModule {}
