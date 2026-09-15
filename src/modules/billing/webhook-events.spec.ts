import { SubscriptionStatus } from '@prisma/client';

import { WebhookService } from './webhook.service';

/**
 * Stripe webhook handlers.
 *
 * Stripe is the source of truth for billing, and these handlers are the only
 * path by which that truth reaches the database. Everything here is money- or
 * access-affecting: a missed `checkout.session.completed` leaves a paying
 * clinic locked out, and a mishandled replacement leaves a customer billed for
 * two subscriptions at once.
 *
 * `webhook.service.spec.ts` covers signature verification, idempotency and the
 * dispatch lifecycle. This suite covers what each individual handler does with
 * the payload, including the shapes Stripe actually sends — expanded objects
 * versus bare ids, missing period data, absent metadata.
 */

const CLINIC = 'clinic-1';

function createStripeClient() {
  return {
    webhooks: { constructEvent: jest.fn() },
    subscriptions: { retrieve: jest.fn(), cancel: jest.fn() },
    checkout: { sessions: { retrieve: jest.fn() } },
  };
}

function createPrisma() {
  return {
    stripeEvent: {
      upsert: jest.fn().mockResolvedValue({ processed: false }),
      update: jest.fn().mockResolvedValue({}),
    },
    subscription: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'local-sub-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    subscriptionItem: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  };
}

const PERIOD_START = 1_780_000_000;
const PERIOD_END = 1_782_000_000;

function stripeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'si_1',
    quantity: 1,
    current_period_start: PERIOD_START,
    current_period_end: PERIOD_END,
    price: {
      id: 'price_1',
      nickname: 'Pro Monthly',
      recurring: { interval: 'month' },
      unit_amount: 19900,
      unit_amount_decimal: '19900',
      currency: 'brl',
    },
    ...overrides,
  };
}

function stripeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_stripe_1',
    customer: 'cus_1',
    status: 'active',
    trial_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    metadata: { clinicId: CLINIC },
    items: { data: [stripeItem()] },
    ...overrides,
  };
}

function checkoutSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cs_1',
    customer: 'cus_1',
    subscription: 'sub_stripe_1',
    metadata: {
      clinicId: CLINIC,
      planId: 'plan-1',
      billingInterval: 'MONTHLY',
    },
    ...overrides,
  };
}

describe('WebhookService — event handlers', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let stripeClient: ReturnType<typeof createStripeClient>;
  let service: WebhookService;

  beforeEach(() => {
    prisma = createPrisma();
    stripeClient = createStripeClient();
    const stripe = {
      getClient: () => stripeClient,
      getWebhookSecret: () => 'whsec_test',
    };
    service = new WebhookService(prisma as never, stripe as never);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  });

  /** Delivers an event through the full verified path. */
  async function deliver(type: string, object: Record<string, unknown>) {
    stripeClient.webhooks.constructEvent.mockReturnValue({
      id: 'evt_1',
      type,
      created: 1_780_000_000,
      data: { object },
    });
    await service.handleWebhook(Buffer.from('{}'), 'sig');
  }

  /** The errorMessage recorded when a handler threw, or null. */
  function recordedFailure(): string | null {
    const failing = prisma.stripeEvent.update.mock.calls.find(
      ([args]) => args.data.errorMessage,
    );
    return failing ? String(failing[0].data.errorMessage) : null;
  }

  // ── checkout.session.completed ─────────────────────────────────────────────

  describe('checkout.session.completed', () => {
    beforeEach(() => {
      stripeClient.subscriptions.retrieve.mockResolvedValue(
        stripeSubscription(),
      );
    });

    it('activates the clinic subscription from the session metadata', async () => {
      await deliver('checkout.session.completed', checkoutSession());

      const args = prisma.subscription.upsert.mock.calls[0][0];
      expect(args.where).toEqual({ clinicId: CLINIC });
      expect(args.create).toMatchObject({
        clinicId: CLINIC,
        planId: 'plan-1',
        stripeCustomerId: 'cus_1',
        stripeSubscriptionId: 'sub_stripe_1',
        billingInterval: 'MONTHLY',
        status: SubscriptionStatus.ACTIVE,
      });
    });

    it('records the billing period from the subscription item', async () => {
      await deliver('checkout.session.completed', checkoutSession());

      const create = prisma.subscription.upsert.mock.calls[0][0].create;
      expect(create.currentPeriodStart.toISOString()).toBe(
        new Date(PERIOD_START * 1000).toISOString(),
      );
      expect(create.currentPeriodEnd.toISOString()).toBe(
        new Date(PERIOD_END * 1000).toISOString(),
      );
    });

    it('leaves the period undefined when Stripe sends no items', async () => {
      stripeClient.subscriptions.retrieve.mockResolvedValue(
        stripeSubscription({ items: { data: [] } }),
      );

      await deliver('checkout.session.completed', checkoutSession());

      const create = prisma.subscription.upsert.mock.calls[0][0].create;
      expect(create.currentPeriodStart).toBeUndefined();
      expect(create.currentPeriodEnd).toBeUndefined();
    });

    it('accepts an expanded customer object as well as a bare id', async () => {
      await deliver(
        'checkout.session.completed',
        checkoutSession({ customer: { id: 'cus_expanded' } }),
      );

      expect(
        prisma.subscription.upsert.mock.calls[0][0].create.stripeCustomerId,
      ).toBe('cus_expanded');
    });

    it('records a trial end date when the subscription is trialing', async () => {
      stripeClient.subscriptions.retrieve.mockResolvedValue(
        stripeSubscription({ status: 'trialing', trial_end: 1_785_000_000 }),
      );

      await deliver('checkout.session.completed', checkoutSession());

      const create = prisma.subscription.upsert.mock.calls[0][0].create;
      expect(create.status).toBe(SubscriptionStatus.TRIALING);
      expect(create.trialEndsAt).toBeInstanceOf(Date);
    });

    it.each([
      [
        'clinicId',
        { clinicId: undefined, planId: 'p', billingInterval: 'MONTHLY' },
      ],
      [
        'planId',
        { clinicId: CLINIC, planId: undefined, billingInterval: 'MONTHLY' },
      ],
      [
        'billingInterval',
        { clinicId: CLINIC, planId: 'p', billingInterval: undefined },
      ],
    ])(
      'records a failure and writes nothing when %s is missing',
      async (_name, metadata) => {
        await deliver(
          'checkout.session.completed',
          checkoutSession({ metadata }),
        );

        expect(prisma.subscription.upsert).not.toHaveBeenCalled();
        expect(recordedFailure()).toMatch(/missing required data/);
      },
    );

    it('rejects an unrecognised billing interval rather than guessing', async () => {
      await deliver(
        'checkout.session.completed',
        checkoutSession({
          metadata: {
            clinicId: CLINIC,
            planId: 'p',
            billingInterval: 'WEEKLY',
          },
        }),
      );

      expect(prisma.subscription.upsert).not.toHaveBeenCalled();
    });

    it('accepts a yearly interval', async () => {
      await deliver(
        'checkout.session.completed',
        checkoutSession({
          metadata: {
            clinicId: CLINIC,
            planId: 'p',
            billingInterval: 'YEARLY',
          },
        }),
      );

      expect(
        prisma.subscription.upsert.mock.calls[0][0].create.billingInterval,
      ).toBe('YEARLY');
    });

    it('records a failure when the session carries no metadata at all', async () => {
      await deliver(
        'checkout.session.completed',
        checkoutSession({ metadata: null }),
      );
      expect(prisma.subscription.upsert).not.toHaveBeenCalled();
    });

    it('records a failure when no subscription is attached to the session', async () => {
      await deliver(
        'checkout.session.completed',
        checkoutSession({ subscription: null }),
      );
      expect(prisma.subscription.upsert).not.toHaveBeenCalled();
    });

    // ── Replacing an existing subscription ───────────────────────────────────

    it('cancels the previous Stripe subscription so the customer is not billed twice', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        stripeSubscriptionId: 'sub_old',
        status: SubscriptionStatus.ACTIVE,
      });

      await deliver('checkout.session.completed', checkoutSession());

      expect(stripeClient.subscriptions.cancel).toHaveBeenCalledWith('sub_old');
    });

    it('does not cancel when the subscription id is unchanged', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        stripeSubscriptionId: 'sub_stripe_1',
        status: SubscriptionStatus.ACTIVE,
      });

      await deliver('checkout.session.completed', checkoutSession());

      expect(stripeClient.subscriptions.cancel).not.toHaveBeenCalled();
    });

    it('does not cancel an already-canceled previous subscription', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        stripeSubscriptionId: 'sub_old',
        status: SubscriptionStatus.CANCELED,
      });

      await deliver('checkout.session.completed', checkoutSession());

      expect(stripeClient.subscriptions.cancel).not.toHaveBeenCalled();
    });

    it('still activates the new subscription when cancelling the old one fails', async () => {
      // Already gone in Stripe is the common case and must not block access.
      prisma.subscription.findUnique.mockResolvedValue({
        stripeSubscriptionId: 'sub_old',
        status: SubscriptionStatus.ACTIVE,
      });
      stripeClient.subscriptions.cancel.mockRejectedValue(
        new Error('No such subscription'),
      );

      await deliver('checkout.session.completed', checkoutSession());

      expect(prisma.subscription.upsert).toHaveBeenCalled();
      expect(recordedFailure()).toBeNull();
    });
  });

  // ── syncCheckoutSession (client-initiated reconciliation) ──────────────────

  describe('syncCheckoutSession', () => {
    beforeEach(() => {
      stripeClient.subscriptions.retrieve.mockResolvedValue(
        stripeSubscription(),
      );
      stripeClient.checkout.sessions.retrieve.mockResolvedValue(
        checkoutSession(),
      );
    });

    it('activates the subscription for the authenticated clinic', async () => {
      await service.syncCheckoutSession('cs_1', CLINIC);

      expect(prisma.subscription.upsert.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC,
      });
    });

    it('refuses a session belonging to another clinic', async () => {
      // Without this, any clinic could activate a plan by quoting someone
      // else's checkout session id.
      await expect(
        service.syncCheckoutSession('cs_1', 'other-clinic'),
      ).rejects.toThrow(/does not belong to the authenticated clinic/);
      expect(prisma.subscription.upsert).not.toHaveBeenCalled();
    });
  });

  // ── customer.subscription.created / updated ────────────────────────────────

  describe('customer.subscription.updated', () => {
    it('syncs status and period onto the local subscription', async () => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'local-1',
        clinicId: CLINIC,
      });

      await deliver(
        'customer.subscription.updated',
        stripeSubscription({ status: 'past_due' }),
      );

      const args = prisma.subscription.update.mock.calls[0][0];
      expect(args.where).toEqual({ id: 'local-1' });
      expect(args.data.status).toBe(SubscriptionStatus.PAST_DUE);
      expect(args.data.currentPeriodEnd).toBeInstanceOf(Date);
    });

    it('handles customer.subscription.created identically', async () => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'local-1',
        clinicId: CLINIC,
      });

      await deliver('customer.subscription.created', stripeSubscription());

      expect(prisma.subscription.update).toHaveBeenCalled();
    });

    it('looks the subscription up by Stripe id first, then customer id', async () => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'local-1',
        clinicId: CLINIC,
      });

      await deliver('customer.subscription.updated', stripeSubscription());

      expect(prisma.subscription.findFirst.mock.calls[0][0].where.OR).toEqual([
        { stripeSubscriptionId: 'sub_stripe_1' },
        { stripeCustomerId: 'cus_1' },
      ]);
    });

    it('ignores an event with no resolvable customer', async () => {
      await deliver(
        'customer.subscription.updated',
        stripeSubscription({ customer: null }),
      );

      expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });

    it('ignores a subscription with no local counterpart without failing the event', async () => {
      prisma.subscription.findFirst.mockResolvedValue(null);

      await deliver('customer.subscription.updated', stripeSubscription());

      expect(prisma.subscription.update).not.toHaveBeenCalled();
      expect(recordedFailure()).toBeNull();
    });

    it('records a cancellation scheduled for the period end', async () => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'local-1',
        clinicId: CLINIC,
      });

      await deliver(
        'customer.subscription.updated',
        stripeSubscription({
          cancel_at_period_end: true,
          canceled_at: 1_781_000_000,
        }),
      );

      const data = prisma.subscription.update.mock.calls[0][0].data;
      expect(data.cancelAtPeriodEnd).toBe(true);
      expect(data.canceledAt).toBeInstanceOf(Date);
    });

    it('records a hosted Billing Portal cancellation, which sets only cancel_at', async () => {
      // Payload shape taken from a real hosted-portal cancellation under Stripe
      // API version 2026-03-25.dahlia: the portal schedules the cancellation
      // through `cancel_at` and leaves `cancel_at_period_end` false. Reading the
      // boolean alone loses the cancellation entirely.
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'local-1',
        clinicId: CLINIC,
      });

      await deliver(
        'customer.subscription.updated',
        stripeSubscription({
          status: 'active',
          cancel_at_period_end: false,
          cancel_at: 1_791_000_000,
          canceled_at: 1_789_500_000,
          ended_at: null,
        }),
      );

      const data = prisma.subscription.update.mock.calls[0][0].data;
      expect(data.cancelAtPeriodEnd).toBe(true);
    });

    it('does not report a scheduled cancellation once the subscription ended', async () => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'local-1',
        clinicId: CLINIC,
      });

      await deliver(
        'customer.subscription.updated',
        stripeSubscription({
          status: 'canceled',
          cancel_at_period_end: false,
          cancel_at: 1_789_000_000,
          canceled_at: 1_789_000_000,
          ended_at: 1_789_000_000,
        }),
      );

      const data = prisma.subscription.update.mock.calls[0][0].data;
      expect(data.cancelAtPeriodEnd).toBe(false);
    });

    it('leaves an ordinary renewing subscription unflagged', async () => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'local-1',
        clinicId: CLINIC,
      });

      await deliver('customer.subscription.updated', stripeSubscription());

      const data = prisma.subscription.update.mock.calls[0][0].data;
      expect(data.cancelAtPeriodEnd).toBe(false);
    });

    it.each([
      ['active', SubscriptionStatus.ACTIVE],
      ['trialing', SubscriptionStatus.TRIALING],
      ['past_due', SubscriptionStatus.PAST_DUE],
      ['canceled', SubscriptionStatus.CANCELED],
      ['unpaid', SubscriptionStatus.UNPAID],
    ])('maps Stripe status %s', async (stripeStatus, expected) => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'local-1',
        clinicId: CLINIC,
      });

      await deliver(
        'customer.subscription.updated',
        stripeSubscription({ status: stripeStatus }),
      );

      expect(prisma.subscription.update.mock.calls[0][0].data.status).toBe(
        expected,
      );
    });
  });

  // ── customer.subscription.deleted ──────────────────────────────────────────

  describe('customer.subscription.deleted', () => {
    it('defaults canceledAt and endedAt to now when Stripe omits them', async () => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'local-1',
        clinicId: CLINIC,
      });

      await deliver(
        'customer.subscription.deleted',
        stripeSubscription({ canceled_at: null, ended_at: null }),
      );

      const data = prisma.subscription.update.mock.calls[0][0].data;
      expect(data.status).toBe(SubscriptionStatus.CANCELED);
      expect(data.canceledAt).toBeInstanceOf(Date);
      expect(data.endedAt).toBeInstanceOf(Date);
    });

    it('uses the Stripe timestamps when present', async () => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'local-1',
        clinicId: CLINIC,
      });

      await deliver(
        'customer.subscription.deleted',
        stripeSubscription({
          canceled_at: 1_781_000_000,
          ended_at: 1_781_500_000,
        }),
      );

      const data = prisma.subscription.update.mock.calls[0][0].data;
      expect(data.canceledAt.toISOString()).toBe(
        new Date(1_781_000_000 * 1000).toISOString(),
      );
      expect(data.endedAt.toISOString()).toBe(
        new Date(1_781_500_000 * 1000).toISOString(),
      );
    });

    it('ignores a deletion with no resolvable customer', async () => {
      await deliver(
        'customer.subscription.deleted',
        stripeSubscription({ customer: null }),
      );
      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });
  });

  // ── invoice.paid / payment_succeeded ───────────────────────────────────────

  describe('invoice payment succeeded', () => {
    const invoiceWithSubscription = {
      customer: 'cus_1',
      parent: { subscription_details: { subscription: 'sub_stripe_1' } },
    };

    it('re-reads the subscription from Stripe and syncs it', async () => {
      stripeClient.subscriptions.retrieve.mockResolvedValue(
        stripeSubscription(),
      );
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'local-1',
        clinicId: CLINIC,
      });

      await deliver('invoice.paid', invoiceWithSubscription);

      expect(stripeClient.subscriptions.retrieve).toHaveBeenCalledWith(
        'sub_stripe_1',
      );
      expect(prisma.subscription.update.mock.calls[0][0].data.status).toBe(
        SubscriptionStatus.ACTIVE,
      );
    });

    it('handles invoice.payment_succeeded identically', async () => {
      stripeClient.subscriptions.retrieve.mockResolvedValue(
        stripeSubscription(),
      );
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'local-1',
        clinicId: CLINIC,
      });

      await deliver('invoice.payment_succeeded', invoiceWithSubscription);

      expect(prisma.subscription.update).toHaveBeenCalled();
    });

    it('reactivates by customer alone when the invoice names no subscription', async () => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'local-1',
        clinicId: CLINIC,
        status: SubscriptionStatus.PAST_DUE,
        stripeSubscriptionId: 'sub_stripe_1',
      });

      await deliver('invoice.paid', { customer: 'cus_1', parent: null });

      expect(prisma.subscription.update.mock.calls[0][0].data).toEqual({
        status: SubscriptionStatus.ACTIVE,
      });
    });

    it('does not resurrect a canceled subscription', async () => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'local-1',
        clinicId: CLINIC,
        status: SubscriptionStatus.CANCELED,
      });

      await deliver('invoice.paid', { customer: 'cus_1', parent: null });

      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });

    it('ignores an invoice with neither customer nor subscription', async () => {
      await deliver('invoice.paid', { customer: null, parent: null });

      expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
      expect(prisma.subscription.update).not.toHaveBeenCalled();
    });
  });

  // ── invoice.payment_failed ─────────────────────────────────────────────────

  describe('invoice.payment_failed', () => {
    it('ignores a failure it cannot attribute to a local subscription', async () => {
      prisma.subscription.findFirst.mockResolvedValue(null);

      await deliver('invoice.payment_failed', {
        customer: 'cus_1',
        parent: { subscription_details: { subscription: 'sub_stripe_1' } },
      });

      expect(prisma.subscription.update).not.toHaveBeenCalled();
      expect(recordedFailure()).toBeNull();
    });

    it('ignores an invoice with neither customer nor subscription', async () => {
      await deliver('invoice.payment_failed', { customer: null, parent: null });
      expect(prisma.subscription.findFirst).not.toHaveBeenCalled();
    });
  });

  // ── Subscription items ─────────────────────────────────────────────────────

  describe('subscription items', () => {
    beforeEach(() => {
      prisma.subscription.findFirst.mockResolvedValue({
        id: 'local-1',
        clinicId: CLINIC,
      });
    });

    it('upserts each item and prunes the ones Stripe no longer reports, in one transaction', async () => {
      await deliver('customer.subscription.updated', stripeSubscription());

      expect(prisma.subscriptionItem.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.subscriptionItem.deleteMany.mock.calls[0][0].where).toEqual(
        {
          subscriptionId: 'local-1',
          stripeSubscriptionItemId: { notIn: ['si_1'] },
        },
      );
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('removes every item when Stripe reports none', async () => {
      await deliver(
        'customer.subscription.updated',
        stripeSubscription({ items: { data: [] } }),
      );

      // No `notIn` guard — everything for this subscription goes.
      expect(prisma.subscriptionItem.deleteMany.mock.calls[0][0].where).toEqual(
        {
          subscriptionId: 'local-1',
        },
      );
    });

    it('normalises the currency to upper case', async () => {
      await deliver('customer.subscription.updated', stripeSubscription());

      expect(
        prisma.subscriptionItem.upsert.mock.calls[0][0].create.currency,
      ).toBe('BRL');
    });

    it('defaults a missing quantity to one', async () => {
      await deliver(
        'customer.subscription.updated',
        stripeSubscription({
          items: { data: [stripeItem({ quantity: null })] },
        }),
      );

      expect(
        prisma.subscriptionItem.upsert.mock.calls[0][0].create.quantity,
      ).toBe(1);
    });

    it('stores a null decimal amount when Stripe omits it', async () => {
      await deliver(
        'customer.subscription.updated',
        stripeSubscription({
          items: {
            data: [
              stripeItem({
                price: {
                  ...stripeItem().price,
                  unit_amount_decimal: null,
                },
              }),
            ],
          },
        }),
      );

      expect(
        prisma.subscriptionItem.upsert.mock.calls[0][0].create
          .unitAmountDecimal,
      ).toBeNull();
    });

    it('keys the upsert on the Stripe item id so a redelivery does not duplicate rows', async () => {
      await deliver('customer.subscription.updated', stripeSubscription());

      expect(prisma.subscriptionItem.upsert.mock.calls[0][0].where).toEqual({
        stripeSubscriptionItemId: 'si_1',
      });
    });
  });

  // ── Unhandled events ───────────────────────────────────────────────────────

  describe('unhandled events', () => {
    it('acknowledges customer.subscription.trial_will_end without changing state', async () => {
      await deliver(
        'customer.subscription.trial_will_end',
        stripeSubscription(),
      );

      expect(prisma.subscription.update).not.toHaveBeenCalled();
      expect(recordedFailure()).toBeNull();
    });

    it('acknowledges an entirely unknown event type', async () => {
      await deliver('some.future.event', {});

      expect(recordedFailure()).toBeNull();
      expect(
        prisma.stripeEvent.update.mock.calls.some(
          ([args]) => args.data.processed,
        ),
      ).toBe(true);
    });
  });
});
