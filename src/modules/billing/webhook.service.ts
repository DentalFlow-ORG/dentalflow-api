import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { BillingInterval, SubscriptionStatus } from '@prisma/client';
import Stripe = require('stripe');

import { PrismaService } from '../../prisma/prisma.service';
import { StripeService } from './stripe.service';

type StripeEvent = ReturnType<Stripe.Stripe['webhooks']['constructEvent']>;
type StripeSubscription = Awaited<ReturnType<Stripe.Stripe['subscriptions']['retrieve']>>;
type StripeInvoice = Awaited<ReturnType<Stripe.Stripe['invoices']['retrieve']>>;
type StripeCheckoutSession = Awaited<ReturnType<Stripe.Stripe['checkout']['sessions']['retrieve']>>;

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
  ) {}

  async handleWebhook(rawBody: Buffer, signature: string): Promise<void> {
    // 1. Verify Stripe signature — throws BadRequest if invalid
    let event: StripeEvent;
    try {
      event = this.stripe.getClient().webhooks.constructEvent(
        rawBody,
        signature,
        this.stripe.getWebhookSecret(),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Stripe signature verification failed: ${message}`);
      throw new BadRequestException('Assinatura do webhook inválida.');
    }

    // 2. Upsert StripeEvent for idempotency and audit.
    //    Uses the Stripe event ID as PK — duplicate deliveries update only
    //    receivedAt, leaving processed/errorMessage untouched.
    const storedEvent = await this.prisma.stripeEvent.upsert({
      where: { id: event.id },
      create: {
        id: event.id,
        type: event.type,
        processed: false,
        rawPayload: event as object,
        createdAt: new Date(event.created * 1000),
      },
      update: { receivedAt: new Date() },
    });

    // 3. Idempotency guard: skip events already successfully processed
    if (storedEvent.processed) {
      this.logger.log(
        `Stripe event ${event.id} (${event.type}) already processed — skipping`,
      );
      return;
    }

    // 4. Dispatch to the appropriate handler
    try {
      await this.dispatch(event);
      await this.prisma.stripeEvent.update({
        where: { id: event.id },
        data: { processed: true, processedAt: new Date(), errorMessage: null },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to process Stripe event ${event.id} (${event.type}): ${message}`,
      );
      await this.prisma.stripeEvent.update({
        where: { id: event.id },
        data: { errorMessage: message },
      });
      // Do NOT re-throw: return 200 to Stripe to prevent infinite retries.
      // Failed events are stored with errorMessage and visible in the admin
      // finance dashboard for manual inspection and replay.
    }
  }

  // -------------------------------------------------------------------
  // Dispatcher
  // -------------------------------------------------------------------

  private async dispatch(event: StripeEvent): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed':
        await this.onCheckoutSessionCompleted(
          event.data.object as StripeCheckoutSession,
        );
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await this.onSubscriptionUpserted(
          event.data.object as StripeSubscription,
        );
        break;
      case 'customer.subscription.deleted':
        await this.onSubscriptionDeleted(
          event.data.object as StripeSubscription,
        );
        break;
      case 'invoice.payment_succeeded':
        await this.onInvoicePaymentSucceeded(
          event.data.object as StripeInvoice,
        );
        break;
      case 'invoice.payment_failed':
        await this.onInvoicePaymentFailed(
          event.data.object as StripeInvoice,
        );
        break;
      default:
        this.logger.log(`Unhandled Stripe event type: ${event.type}`);
    }
  }

  // -------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------

  /**
   * The canonical event that activates a subscription.
   * Reads clinicId / planId / billingInterval from the session metadata set
   * during checkout session creation, so we never trust client-supplied IDs.
   */
  private async onCheckoutSessionCompleted(
    session: StripeCheckoutSession,
  ): Promise<void> {
    const meta = session.metadata;
    const clinicId = meta?.clinicId;
    const planId = meta?.planId;
    const billingInterval = meta?.billingInterval as BillingInterval | undefined;
    const stripeCustomerId = this.resolveId(session.customer);
    const stripeSubscriptionId = this.resolveId(session.subscription);

    if (
      !clinicId ||
      !planId ||
      !billingInterval ||
      !stripeCustomerId ||
      !stripeSubscriptionId
    ) {
      throw new Error(
        `checkout.session.completed missing required data — ` +
          `clinicId: ${clinicId}, planId: ${planId}, ` +
          `stripeCustomerId: ${stripeCustomerId}, stripeSubscriptionId: ${stripeSubscriptionId}`,
      );
    }

    if (!Object.values(BillingInterval).includes(billingInterval)) {
      throw new Error(
        `Invalid billingInterval in session metadata: ${billingInterval}`,
      );
    }

    await this.prisma.subscription.upsert({
      where: { clinicId },
      create: {
        clinicId,
        planId,
        stripeCustomerId,
        stripeSubscriptionId,
        billingInterval,
        status: SubscriptionStatus.ACTIVE,
      },
      update: {
        planId,
        stripeCustomerId,
        stripeSubscriptionId,
        billingInterval,
        status: SubscriptionStatus.ACTIVE,
      },
    });
  }

  /**
   * Handles both customer.subscription.created and customer.subscription.updated.
   * Syncs status and period dates from the Stripe subscription object.
   */
  private async onSubscriptionUpserted(
    sub: StripeSubscription,
  ): Promise<void> {
    const stripeCustomerId = this.resolveId(sub.customer);
    if (!stripeCustomerId) return;

    const existing = await this.findLocalSubscription(
      sub.id,
      stripeCustomerId,
    );
    if (!existing) {
      this.logger.warn(
        `No local subscription found for Stripe subscription ${sub.id} / customer ${stripeCustomerId}`,
      );
      return;
    }

    const firstItem = sub.items?.data?.[0];
    await this.prisma.subscription.update({
      where: { id: existing.id },
      data: {
        stripeSubscriptionId: sub.id,
        status: this.mapStripeStatus(sub.status),
        currentPeriodStart: firstItem
          ? new Date(firstItem.current_period_start * 1000)
          : undefined,
        currentPeriodEnd: firstItem
          ? new Date(firstItem.current_period_end * 1000)
          : undefined,
        trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        canceledAt: sub.canceled_at
          ? new Date(sub.canceled_at * 1000)
          : null,
      },
    });
  }

  /**
   * Marks the local subscription as canceled when Stripe deletes the subscription.
   */
  private async onSubscriptionDeleted(
    sub: StripeSubscription,
  ): Promise<void> {
    const stripeCustomerId = this.resolveId(sub.customer);
    if (!stripeCustomerId) return;

    const existing = await this.findLocalSubscription(
      sub.id,
      stripeCustomerId,
    );
    if (!existing) {
      this.logger.warn(
        `No local subscription found for deleted Stripe subscription ${sub.id}`,
      );
      return;
    }

    await this.prisma.subscription.update({
      where: { id: existing.id },
      data: {
        status: SubscriptionStatus.CANCELED,
        canceledAt: sub.canceled_at
          ? new Date(sub.canceled_at * 1000)
          : new Date(),
        endedAt: sub.ended_at ? new Date(sub.ended_at * 1000) : new Date(),
      },
    });
  }

  /**
   * Reactivates ACTIVE status when a previously failed invoice is paid.
   */
  private async onInvoicePaymentSucceeded(
    invoice: StripeInvoice,
  ): Promise<void> {
    const stripeCustomerId = this.resolveId(invoice.customer);
    const stripeSubscriptionId = this.resolveId(
      invoice.parent?.subscription_details?.subscription ?? null,
    );
    if (!stripeCustomerId && !stripeSubscriptionId) return;

    const existing = await this.findLocalSubscription(
      stripeSubscriptionId,
      stripeCustomerId,
    );
    if (!existing) return;

    await this.prisma.subscription.update({
      where: { id: existing.id },
      data: { status: SubscriptionStatus.ACTIVE },
    });
  }

  /**
   * Sets status to PAST_DUE when a subscription invoice fails to collect.
   */
  private async onInvoicePaymentFailed(
    invoice: StripeInvoice,
  ): Promise<void> {
    const stripeCustomerId = this.resolveId(invoice.customer);
    const stripeSubscriptionId = this.resolveId(
      invoice.parent?.subscription_details?.subscription ?? null,
    );
    if (!stripeCustomerId && !stripeSubscriptionId) return;

    const existing = await this.findLocalSubscription(
      stripeSubscriptionId,
      stripeCustomerId,
    );
    if (!existing) return;

    await this.prisma.subscription.update({
      where: { id: existing.id },
      data: { status: SubscriptionStatus.PAST_DUE },
    });
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  /**
   * Resolves a Stripe field that can arrive as a plain ID string or an
   * expanded object (depending on API expand settings).
   */
  private resolveId(
    field: string | { id: string } | null | undefined,
  ): string | null {
    if (!field) return null;
    return typeof field === 'string' ? field : field.id;
  }

  /**
   * Looks up the local Subscription by Stripe subscription ID first,
   * then falls back to Stripe customer ID.
   */
  private async findLocalSubscription(
    stripeSubscriptionId: string | null | undefined,
    stripeCustomerId: string | null | undefined,
  ) {
    if (!stripeSubscriptionId && !stripeCustomerId) return null;

    return this.prisma.subscription.findFirst({
      where: {
        OR: [
          ...(stripeSubscriptionId ? [{ stripeSubscriptionId }] : []),
          ...(stripeCustomerId ? [{ stripeCustomerId }] : []),
        ],
      },
    });
  }

  /**
   * Maps Stripe subscription status strings to local SubscriptionStatus enum.
   * incomplete_expired is treated as CANCELED since the subscription never activated.
   */
  private mapStripeStatus(
    stripeStatus: StripeSubscription['status'],
  ): SubscriptionStatus {
    const map: Partial<Record<StripeSubscription['status'], SubscriptionStatus>> =
      {
        trialing: SubscriptionStatus.TRIALING,
        active: SubscriptionStatus.ACTIVE,
        past_due: SubscriptionStatus.PAST_DUE,
        canceled: SubscriptionStatus.CANCELED,
        unpaid: SubscriptionStatus.UNPAID,
        paused: SubscriptionStatus.PAUSED,
        incomplete: SubscriptionStatus.INCOMPLETE,
        incomplete_expired: SubscriptionStatus.CANCELED,
      };
    return map[stripeStatus] ?? SubscriptionStatus.ACTIVE;
  }
}
