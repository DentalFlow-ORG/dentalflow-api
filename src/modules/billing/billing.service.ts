import { Injectable } from '@nestjs/common';
import { stripeConfig } from '../../config/stripe.config';

@Injectable()
export class BillingService {
  getTemplate() {
    return {
      module: 'billing',
      ready: true,
      stripeConfigured: Boolean(stripeConfig.secretKey),
    };
  }
}
