import { Injectable, Logger } from '@nestjs/common';
import type StripeConstructor from 'stripe';

import { stripeConfig } from '../../config/stripe.config';

const stripeModule: unknown = module.require('stripe');
const Stripe = stripeModule as typeof StripeConstructor;

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private client: StripeConstructor.Stripe | null = null;

  constructor() {
    if (stripeConfig.secretKey) {
      this.client = new Stripe(stripeConfig.secretKey, {
        // API version bundled with stripe@22.0.2. Update when upgrading the package.
        apiVersion: '2026-03-25.dahlia',
      });
    } else {
      this.logger.warn(
        'STRIPE_SECRET_KEY is not set — Stripe calls will throw when attempted',
      );
    }
  }

  /**
   * Returns the initialised Stripe client.
   * Throws if STRIPE_SECRET_KEY was missing at startup.
   * Call this inside checkout, webhook, and portal handlers — not at module init.
   */
  getClient(): StripeConstructor.Stripe {
    if (!this.client) {
      throw new Error(
        'Stripe client is not initialised. Set STRIPE_SECRET_KEY in your environment.',
      );
    }
    return this.client;
  }

  /**
   * Returns the webhook signing secret needed to verify incoming Stripe events.
   * Throws if STRIPE_WEBHOOK_SECRET is missing.
   */
  getWebhookSecret(): string {
    if (!stripeConfig.webhookSecret) {
      throw new Error(
        'STRIPE_WEBHOOK_SECRET is not set. Set it in your environment.',
      );
    }
    return stripeConfig.webhookSecret;
  }
}
