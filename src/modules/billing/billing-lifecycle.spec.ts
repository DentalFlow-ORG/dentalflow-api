import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SubscriptionStatus } from '@prisma/client';

import { BillingService } from './billing.service';

/**
 * Subscription lifecycle: checkout, trial, plan change, portal and cancel.
 *
 * `billing.service.spec.ts` covers `getCurrentSubscriptionStatus`, which
 * decides whether a clinic may use the product at all. This suite covers the
 * transitions into and out of those states — the operations that create Stripe
 * objects and take money.
 *
 * The recurring theme is refusing to act on an inconsistent state rather than
 * doing something expensive and wrong: no second checkout while a subscription
 * is live, no second free trial, no plan change against a subscription Stripe
 * does not have.
 */

const CLINIC = 'clinic-1';
const USER = 'user-1';

const PLAN = {
  id: 'plan-pro',
  slug: 'professional',
  name: 'Professional',
  isActive: true,
  isPublic: true,
  stripePriceIdMonthly: 'price_monthly',
  stripePriceIdYearly: 'price_yearly',
  priceMonthly: 19900,
  priceYearly: 199000,
};

function createStripeClient() {
  return {
    customers: { create: jest.fn().mockResolvedValue({ id: 'cus_new' }) },
    checkout: {
      sessions: {
        create: jest
          .fn()
          .mockResolvedValue({ url: 'https://checkout.stripe.test/s' }),
      },
    },
    subscriptions: {
      retrieve: jest.fn(),
      update: jest.fn(),
    },
    billingPortal: {
      sessions: {
        create: jest
          .fn()
          .mockResolvedValue({ url: 'https://portal.stripe.test/p' }),
      },
    },
  };
}

function createPrisma() {
  return {
    subscription: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'sub-local' }),
      update: jest.fn().mockResolvedValue({}),
    },
    plan: {
      findFirst: jest.fn().mockResolvedValue(PLAN),
      findMany: jest.fn().mockResolvedValue([]),
    },
    clinic: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        name: 'Alpha Odonto',
        email: 'alpha@example.test',
      }),
    },
  };
}

function stripeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_stripe',
    status: 'active',
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    items: {
      data: [
        {
          id: 'si_1',
          current_period_start: 1_780_000_000,
          current_period_end: 1_782_000_000,
        },
      ],
    },
    ...overrides,
  };
}

describe('BillingService — subscription lifecycle', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let stripeClient: ReturnType<typeof createStripeClient>;
  let service: BillingService;

  beforeEach(() => {
    prisma = createPrisma();
    stripeClient = createStripeClient();
    service = new BillingService(
      prisma as never,
      {
        getClient: () => stripeClient,
        getWebhookSecret: () => 'whsec',
      } as never,
    );
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });

  // ── Plan resolution, shared by several operations ──────────────────────────

  describe('plan resolution', () => {
    it('refuses a request that names no plan', async () => {
      await expect(
        service.createCheckoutSession(CLINIC, USER, {
          billingInterval: 'MONTHLY',
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('treats a whitespace-only plan key as absent', async () => {
      await expect(
        service.createCheckoutSession(CLINIC, USER, {
          billingInterval: 'MONTHLY',
          planKey: '   ',
        } as never),
      ).rejects.toThrow(/Informe o plano/);
    });

    it('looks a plan up by id when one is given', async () => {
      await service
        .createCheckoutSession(CLINIC, USER, {
          billingInterval: 'MONTHLY',
          planId: 'plan-pro',
        } as never)
        .catch(() => undefined);

      expect(prisma.plan.findFirst.mock.calls[0][0].where).toMatchObject({
        id: 'plan-pro',
        isActive: true,
        isPublic: true,
      });
    });

    it('looks a plan up by slug when no id is given', async () => {
      await service
        .createCheckoutSession(CLINIC, USER, {
          billingInterval: 'MONTHLY',
          planKey: 'professional',
        } as never)
        .catch(() => undefined);

      expect(prisma.plan.findFirst.mock.calls[0][0].where).toMatchObject({
        slug: 'professional',
      });
    });

    it('never offers a private or inactive plan', async () => {
      await service
        .createCheckoutSession(CLINIC, USER, {
          billingInterval: 'MONTHLY',
          planKey: 'professional',
        } as never)
        .catch(() => undefined);

      expect(prisma.plan.findFirst.mock.calls[0][0].where).toMatchObject({
        isActive: true,
        isPublic: true,
      });
    });

    it('reports an unknown plan as not found', async () => {
      prisma.plan.findFirst.mockResolvedValue(null);

      await expect(
        service.createCheckoutSession(CLINIC, USER, {
          billingInterval: 'MONTHLY',
          planKey: 'ghost',
        } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects an unrecognised billing interval rather than defaulting', async () => {
      await expect(
        service.createCheckoutSession(CLINIC, USER, {
          billingInterval: 'WEEKLY',
          planKey: 'professional',
        } as never),
      ).rejects.toThrow(/MONTHLY ou YEARLY/);
    });
  });

  // ── Checkout ───────────────────────────────────────────────────────────────

  describe('createCheckoutSession', () => {
    const dto = {
      billingInterval: 'MONTHLY',
      planKey: 'professional',
    } as never;

    it('returns the Stripe checkout URL', async () => {
      await expect(
        service.createCheckoutSession(CLINIC, USER, dto),
      ).resolves.toEqual({
        url: 'https://checkout.stripe.test/s',
      });
    });

    it('uses the monthly price for a monthly interval', async () => {
      await service.createCheckoutSession(CLINIC, USER, dto);

      expect(
        stripeClient.checkout.sessions.create.mock.calls[0][0].line_items,
      ).toEqual([{ price: 'price_monthly', quantity: 1 }]);
    });

    it('uses the yearly price for a yearly interval', async () => {
      await service.createCheckoutSession(CLINIC, USER, {
        billingInterval: 'YEARLY',
        planKey: 'professional',
      } as never);

      expect(
        stripeClient.checkout.sessions.create.mock.calls[0][0].line_items,
      ).toEqual([{ price: 'price_yearly', quantity: 1 }]);
    });

    it('refuses when the plan has no price for the chosen interval', async () => {
      prisma.plan.findFirst.mockResolvedValue({
        ...PLAN,
        stripePriceIdMonthly: null,
      });

      await expect(
        service.createCheckoutSession(CLINIC, USER, dto),
      ).rejects.toThrow(/preço mensal/);
    });

    it('names the yearly interval in its refusal', async () => {
      prisma.plan.findFirst.mockResolvedValue({
        ...PLAN,
        stripePriceIdYearly: null,
      });

      await expect(
        service.createCheckoutSession(CLINIC, USER, {
          billingInterval: 'YEARLY',
          planKey: 'professional',
        } as never),
      ).rejects.toThrow(/preço anual/);
    });

    it.each([SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING])(
      'refuses a second checkout while a %s subscription exists',
      async (status) => {
        prisma.subscription.findUnique.mockResolvedValue({
          stripeSubscriptionId: 'sub_live',
          status,
        });

        await expect(
          service.createCheckoutSession(CLINIC, USER, dto),
        ).rejects.toThrow(/já possui uma assinatura ativa/);
        expect(stripeClient.checkout.sessions.create).not.toHaveBeenCalled();
      },
    );

    it('allows a new checkout after cancellation', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        stripeSubscriptionId: 'sub_old',
        stripeCustomerId: 'cus_existing',
        status: SubscriptionStatus.CANCELED,
      });

      await expect(
        service.createCheckoutSession(CLINIC, USER, dto),
      ).resolves.toBeDefined();
    });

    it('reuses the existing Stripe customer instead of creating a duplicate', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        stripeCustomerId: 'cus_existing',
        status: SubscriptionStatus.INCOMPLETE,
      });

      await service.createCheckoutSession(CLINIC, USER, dto);

      expect(stripeClient.customers.create).not.toHaveBeenCalled();
      expect(
        stripeClient.checkout.sessions.create.mock.calls[0][0].customer,
      ).toBe('cus_existing');
    });

    it('creates a Stripe customer from the clinic record on first checkout', async () => {
      await service.createCheckoutSession(CLINIC, USER, dto);

      expect(stripeClient.customers.create).toHaveBeenCalledWith({
        name: 'Alpha Odonto',
        email: 'alpha@example.test',
        metadata: { clinicId: CLINIC },
      });
    });

    it('omits the email when the clinic has none on file', async () => {
      prisma.clinic.findUniqueOrThrow.mockResolvedValue({
        name: 'Alpha',
        email: null,
      });

      await service.createCheckoutSession(CLINIC, USER, dto);

      expect(
        stripeClient.customers.create.mock.calls[0][0].email,
      ).toBeUndefined();
    });

    it('records the local subscription as INCOMPLETE until Stripe confirms', async () => {
      await service.createCheckoutSession(CLINIC, USER, dto);

      expect(prisma.subscription.upsert.mock.calls[0][0].create.status).toBe(
        SubscriptionStatus.INCOMPLETE,
      );
    });

    it('does not overwrite an existing status when updating', async () => {
      await service.createCheckoutSession(CLINIC, USER, dto);

      expect(
        prisma.subscription.upsert.mock.calls[0][0].update,
      ).not.toHaveProperty('status');
    });

    it('carries the identifiers the webhook needs in session metadata', async () => {
      await service.createCheckoutSession(CLINIC, USER, dto);

      expect(
        stripeClient.checkout.sessions.create.mock.calls[0][0].metadata,
      ).toMatchObject({
        clinicId: CLINIC,
        planId: PLAN.id,
        billingInterval: 'MONTHLY',
        userId: USER,
      });
    });

    it('asks Stripe to return the session id so the client can reconcile', async () => {
      // REGRESSION: Stripe substitutes the template variable by matching the
      // literal string `{CHECKOUT_SESSION_ID}`. Percent-encoding the braces —
      // which `URLSearchParams.toString()` does — leaves the placeholder
      // unsubstituted, so the client lands on the success page with a literal
      // `%7BCHECKOUT_SESSION_ID%7D` and POST /billing/checkout-session/sync
      // can never reconcile the payment.
      await service.createCheckoutSession(CLINIC, USER, dto);

      const successUrl = String(
        stripeClient.checkout.sessions.create.mock.calls[0][0].success_url,
      );
      expect(successUrl).toContain('session_id={CHECKOUT_SESSION_ID}');
      expect(successUrl).not.toContain('%7B');
    });

    it('keeps a success URL that already carries the placeholder intact', async () => {
      // The two branches of buildCheckoutSuccessUrl must agree: a caller who
      // puts the placeholder in STRIPE_SUCCESS_URL and one who does not should
      // both end up with a literal placeholder.
      await service.createCheckoutSession(CLINIC, USER, dto);

      const successUrl = String(
        stripeClient.checkout.sessions.create.mock.calls[0][0].success_url,
      );
      expect(successUrl.match(/\{CHECKOUT_SESSION_ID\}/g)).toHaveLength(1);
    });

    it('fails loudly when Stripe returns a session with no URL', async () => {
      stripeClient.checkout.sessions.create.mockResolvedValue({ url: null });

      await expect(
        service.createCheckoutSession(CLINIC, USER, dto),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  // ── Trial ──────────────────────────────────────────────────────────────────

  describe('startTrial', () => {
    const dto = {
      billingInterval: 'MONTHLY',
      planKey: 'professional',
    } as never;

    beforeEach(() => {
      prisma.subscription.findUnique.mockResolvedValue(null);
    });

    it('starts a trial for a clinic that has never had one', async () => {
      await service.startTrial(CLINIC, dto);

      const create = prisma.subscription.upsert.mock.calls[0][0].create;
      expect(create.status).toBe(SubscriptionStatus.TRIALING);
      expect(create.trialEndsAt).toBeInstanceOf(Date);
      expect(create.trialEndsAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('refuses a second trial once one has been used', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        trialEndsAt: new Date('2026-01-01'),
      });

      await expect(service.startTrial(CLINIC, dto)).rejects.toThrow(
        /já foi utilizado/,
      );
      expect(prisma.subscription.upsert).not.toHaveBeenCalled();
    });

    it('refuses a trial when a live Stripe subscription already exists', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        trialEndsAt: null,
        stripeSubscriptionId: 'sub_live',
        status: SubscriptionStatus.ACTIVE,
      });

      await expect(service.startTrial(CLINIC, dto)).rejects.toThrow(
        /já possui uma assinatura vinculada/,
      );
    });

    it('allows a trial when the previous Stripe subscription was canceled', async () => {
      prisma.subscription.findUnique
        .mockResolvedValueOnce({
          trialEndsAt: null,
          stripeSubscriptionId: 'sub_old',
          status: SubscriptionStatus.CANCELED,
        })
        .mockResolvedValue(null);

      await expect(service.startTrial(CLINIC, dto)).resolves.toBeDefined();
    });

    it('clears any previous cancellation when re-entering a trial', async () => {
      await service.startTrial(CLINIC, dto);

      expect(prisma.subscription.upsert.mock.calls[0][0].update).toMatchObject({
        cancelAtPeriodEnd: false,
        canceledAt: null,
        endedAt: null,
      });
    });

    it('reports the resulting subscription status back to the caller', async () => {
      const result = await service.startTrial(CLINIC, dto);
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('accessAllowed');
    });
  });

  // ── Plan change ────────────────────────────────────────────────────────────

  describe('changeSubscriptionPlan', () => {
    const dto = { billingInterval: 'YEARLY', planKey: 'professional' } as never;

    beforeEach(() => {
      prisma.subscription.findUnique.mockResolvedValue({
        stripeSubscriptionId: 'sub_stripe',
        status: SubscriptionStatus.ACTIVE,
      });
      stripeClient.subscriptions.retrieve.mockResolvedValue(
        stripeSubscription(),
      );
      stripeClient.subscriptions.update.mockResolvedValue(stripeSubscription());
    });

    it('swaps the subscription item to the new price', async () => {
      await service.changeSubscriptionPlan(CLINIC, dto);

      expect(stripeClient.subscriptions.update.mock.calls[0][1].items).toEqual([
        { id: 'si_1', price: 'price_yearly' },
      ]);
    });

    it('prorates the change rather than double-charging', async () => {
      await service.changeSubscriptionPlan(CLINIC, dto);

      expect(
        stripeClient.subscriptions.update.mock.calls[0][1].proration_behavior,
      ).toBe('create_prorations');
    });

    it('keeps a portal-scheduled cancellation visible after a plan change', async () => {
      // Changing plan must not erase a cancellation the customer scheduled in
      // the hosted portal, which Stripe reports through cancel_at alone.
      stripeClient.subscriptions.update.mockResolvedValue(
        stripeSubscription({
          cancel_at_period_end: false,
          cancel_at: 1_791_000_000,
          canceled_at: 1_789_500_000,
        }),
      );

      await service.changeSubscriptionPlan(CLINIC, dto);

      expect(prisma.subscription.update.mock.calls[0][0].data).toMatchObject({
        cancelAtPeriodEnd: true,
      });
    });

    it('refuses when the clinic has no Stripe subscription', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        stripeSubscriptionId: null,
      });

      await expect(service.changeSubscriptionPlan(CLINIC, dto)).rejects.toThrow(
        /Nenhuma assinatura ativa da Stripe/,
      );
    });

    it('refuses when the clinic has no subscription row at all', async () => {
      prisma.subscription.findUnique.mockResolvedValue(null);

      await expect(service.changeSubscriptionPlan(CLINIC, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it.each([
      SubscriptionStatus.ACTIVE,
      SubscriptionStatus.TRIALING,
      SubscriptionStatus.PAST_DUE,
    ])('allows a change from %s', async (status) => {
      prisma.subscription.findUnique.mockResolvedValue({
        stripeSubscriptionId: 'sub_stripe',
        status,
      });

      await expect(
        service.changeSubscriptionPlan(CLINIC, dto),
      ).resolves.toBeDefined();
    });

    it.each([
      SubscriptionStatus.CANCELED,
      SubscriptionStatus.UNPAID,
      SubscriptionStatus.INCOMPLETE,
      SubscriptionStatus.PAUSED,
    ])('refuses a change from %s', async (status) => {
      prisma.subscription.findUnique.mockResolvedValue({
        stripeSubscriptionId: 'sub_stripe',
        status,
      });

      await expect(service.changeSubscriptionPlan(CLINIC, dto)).rejects.toThrow(
        /não está em um estado permitido/,
      );
      expect(stripeClient.subscriptions.update).not.toHaveBeenCalled();
    });

    it('refuses when the Stripe subscription has no billable item', async () => {
      stripeClient.subscriptions.retrieve.mockResolvedValue(
        stripeSubscription({ items: { data: [] } }),
      );

      await expect(service.changeSubscriptionPlan(CLINIC, dto)).rejects.toThrow(
        /não possui item de cobrança/,
      );
    });

    it('refuses when the target plan has no price for the interval', async () => {
      prisma.plan.findFirst.mockResolvedValue({
        ...PLAN,
        stripePriceIdYearly: null,
      });

      await expect(service.changeSubscriptionPlan(CLINIC, dto)).rejects.toThrow(
        /preço anual/,
      );
      expect(stripeClient.subscriptions.retrieve).not.toHaveBeenCalled();
    });

    it('writes the new plan and period back locally', async () => {
      await service.changeSubscriptionPlan(CLINIC, dto);

      const data = prisma.subscription.update.mock.calls[0][0].data;
      expect(data.planId).toBe(PLAN.id);
      expect(data.billingInterval).toBe('YEARLY');
      expect(data.currentPeriodEnd).toBeInstanceOf(Date);
    });

    it('leaves the period undefined when Stripe returns no item', async () => {
      stripeClient.subscriptions.update.mockResolvedValue(
        stripeSubscription({ items: { data: [] } }),
      );

      await service.changeSubscriptionPlan(CLINIC, dto);

      expect(
        prisma.subscription.update.mock.calls[0][0].data.currentPeriodEnd,
      ).toBeUndefined();
    });

    it('records the change request time in Stripe metadata for reconciliation', async () => {
      await service.changeSubscriptionPlan(CLINIC, dto);

      expect(
        stripeClient.subscriptions.update.mock.calls[0][1].metadata,
      ).toMatchObject({
        clinicId: CLINIC,
        planId: PLAN.id,
        billingInterval: 'YEARLY',
      });
    });
  });

  // ── Portal ─────────────────────────────────────────────────────────────────

  describe('createPortalSession', () => {
    it('returns the portal URL for a clinic with a billing customer', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        stripeCustomerId: 'cus_1',
      });

      await expect(service.createPortalSession(CLINIC)).resolves.toEqual({
        url: 'https://portal.stripe.test/p',
      });
    });

    it('reports no subscription as not found', async () => {
      prisma.subscription.findUnique.mockResolvedValue(null);

      await expect(service.createPortalSession(CLINIC)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('explains that checkout must be completed first when there is no customer', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        stripeCustomerId: null,
      });

      await expect(service.createPortalSession(CLINIC)).rejects.toThrow(
        /Conclua o processo de assinatura/,
      );
    });
  });

  // ── Cancellation ───────────────────────────────────────────────────────────

  describe('cancelSubscription', () => {
    const periodEnd = new Date('2026-07-01T00:00:00.000Z');

    beforeEach(() => {
      prisma.subscription.findUnique.mockResolvedValue({
        stripeSubscriptionId: 'sub_stripe',
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: periodEnd,
      });
      stripeClient.subscriptions.update.mockResolvedValue({});
    });

    it('schedules the cancellation for the period end rather than cutting access now', async () => {
      const result = await service.cancelSubscription(CLINIC);

      expect(stripeClient.subscriptions.update).toHaveBeenCalledWith(
        'sub_stripe',
        {
          cancel_at_period_end: true,
        },
      );
      expect(result.cancelAtPeriodEnd).toBe(true);
      expect(result.currentPeriodEnd).toBe(periodEnd);
    });

    it('mirrors the scheduled cancellation locally', async () => {
      await service.cancelSubscription(CLINIC);

      expect(prisma.subscription.update.mock.calls[0][0]).toEqual({
        where: { clinicId: CLINIC },
        data: { cancelAtPeriodEnd: true },
      });
    });

    it('tells the customer until when they keep access, in Brazil time', async () => {
      // REGRESSION: the date was rendered with the *server's* timezone. On
      // Render (UTC) a period ending 2026-07-01T00:00:00Z printed 01/07/2026,
      // while the Brazilian customer's access actually ends on 30/06 at 21:00
      // local. The spy asserts the formatter is pinned to Brazil rather than
      // asserting a string, so the test means the same thing on any machine.
      const spy = jest.spyOn(Date.prototype, 'toLocaleDateString');

      const result = await service.cancelSubscription(CLINIC);

      expect(spy).toHaveBeenCalledWith(
        'pt-BR',
        expect.objectContaining({ timeZone: 'America/Sao_Paulo' }),
      );
      expect(result.message).toMatch(/\d{2}\/\d{2}\/\d{4}/);
      spy.mockRestore();
    });

    it('omits the date when no period end is known', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        stripeSubscriptionId: 'sub_stripe',
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: null,
      });

      const result = await service.cancelSubscription(CLINIC);
      expect(result.message).toContain('final do período.');
    });

    it('reports no subscription as not found', async () => {
      prisma.subscription.findUnique.mockResolvedValue(null);

      await expect(service.cancelSubscription(CLINIC)).rejects.toThrow(
        NotFoundException,
      );
    });

    it.each([SubscriptionStatus.CANCELED, SubscriptionStatus.INCOMPLETE])(
      'refuses to cancel a %s subscription',
      async (status) => {
        prisma.subscription.findUnique.mockResolvedValue({
          stripeSubscriptionId: 'sub_stripe',
          status,
        });

        await expect(service.cancelSubscription(CLINIC)).rejects.toThrow(
          NotFoundException,
        );
        expect(stripeClient.subscriptions.update).not.toHaveBeenCalled();
      },
    );

    it('refuses when the Stripe subscription id has not arrived yet', async () => {
      prisma.subscription.findUnique.mockResolvedValue({
        stripeSubscriptionId: null,
        status: SubscriptionStatus.ACTIVE,
      });

      await expect(service.cancelSubscription(CLINIC)).rejects.toThrow(
        /ainda não possui um ID de cobrança/,
      );
    });
  });

  // ── Template ───────────────────────────────────────────────────────────────

  it('reports module readiness and Stripe configuration', () => {
    expect(service.getTemplate()).toMatchObject({
      module: 'billing',
      ready: true,
    });
  });
});
