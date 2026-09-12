import { SubscriptionStatus } from '@prisma/client';

import { AdminFinanceService } from './admin-finance.service';

/**
 * Platform revenue reporting for the ADMIN dashboard.
 *
 * The arithmetic here is the part that matters: MRR and ARR are derived from
 * Stripe subscription items, normalised across billing intervals, quantities
 * and currencies. A mistake is silent — the dashboard simply shows a wrong
 * number — so the conversions are pinned explicitly rather than inferred from
 * a single happy-path fixture.
 */

type Mock = jest.Mock;

function createPrisma() {
  const prisma = {
    plan: { findMany: jest.fn().mockResolvedValue([]) },
    subscription: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    stripeEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    $transaction: jest.fn((operations: unknown[]) => Promise.all(operations)),
  };
  return prisma;
}

const PLAN = {
  id: 'plan-pro',
  name: 'Professional',
  slug: 'professional',
  description: 'Pro plan',
  stripePriceIdMonthly: 'price_monthly',
  stripePriceIdYearly: 'price_yearly',
  priceMonthly: 19900,
  priceYearly: 199000,
  maxProfiles: 5,
  maxServicesPerProfile: 20,
  hasAppointments: true,
  hasAnalytics: true,
  hasCustomDomain: false,
  hasPrioritySupport: false,
  isActive: true,
  isPublic: true,
  displayOrder: 1,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const CLINIC = {
  id: 'clinic-1',
  name: 'Alpha Odonto',
  email: 'alpha@example.test',
};

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    planId: PLAN.id,
    plan: PLAN,
    clinic: CLINIC,
    items: [],
    status: SubscriptionStatus.ACTIVE,
    billingInterval: 'MONTHLY',
    trialEndsAt: null,
    currentPeriodStart: new Date('2026-01-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-02-01T00:00:00.000Z'),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    endedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    stripePriceId: 'price_monthly',
    priceNickname: 'Pro Monthly',
    billingInterval: 'MONTHLY',
    unitAmount: 10000,
    unitAmountDecimal: null,
    currency: 'BRL',
    quantity: 1,
    ...overrides,
  };
}

describe('AdminFinanceService', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: AdminFinanceService;

  beforeEach(() => {
    prisma = createPrisma();
    service = new AdminFinanceService(prisma as never);
  });

  // ── Revenue arithmetic ─────────────────────────────────────────────────────

  describe('getSummary revenue', () => {
    it('reports a monthly subscription at its face value as MRR and twelve times that as ARR', async () => {
      prisma.plan.findMany.mockResolvedValue([PLAN]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ items: [item({ unitAmount: 10000 })] }),
      ]);

      const summary = await service.getSummary();

      expect(summary.kpis.estimatedMrr).toBe(10000);
      expect(summary.kpis.estimatedArr).toBe(120000);
    });

    it('divides a yearly subscription by twelve for MRR', async () => {
      prisma.plan.findMany.mockResolvedValue([PLAN]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({
          billingInterval: 'YEARLY',
          items: [item({ billingInterval: 'YEARLY', unitAmount: 120000 })],
        }),
      ]);

      const summary = await service.getSummary();

      expect(summary.kpis.estimatedMrr).toBe(10000);
      expect(summary.kpis.estimatedArr).toBe(120000);
    });

    it('multiplies by quantity', async () => {
      prisma.plan.findMany.mockResolvedValue([PLAN]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ items: [item({ unitAmount: 10000, quantity: 3 })] }),
      ]);

      const summary = await service.getSummary();
      expect(summary.kpis.estimatedMrr).toBe(30000);
    });

    it('treats a zero quantity as one rather than erasing the revenue', async () => {
      prisma.plan.findMany.mockResolvedValue([PLAN]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ items: [item({ unitAmount: 10000, quantity: 0 })] }),
      ]);

      const summary = await service.getSummary();
      expect(summary.kpis.estimatedMrr).toBe(10000);
    });

    it('falls back to unitAmountDecimal when unitAmount is absent', async () => {
      prisma.plan.findMany.mockResolvedValue([PLAN]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({
          items: [item({ unitAmount: null, unitAmountDecimal: '12345' })],
        }),
      ]);

      const summary = await service.getSummary();
      expect(summary.kpis.estimatedMrr).toBe(12345);
    });

    it('treats an unparseable decimal amount as zero instead of NaN', async () => {
      prisma.plan.findMany.mockResolvedValue([PLAN]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({
          items: [
            item({ unitAmount: null, unitAmountDecimal: 'not-a-number' }),
          ],
        }),
      ]);

      const summary = await service.getSummary();
      expect(summary.kpis.estimatedMrr).toBe(0);
      expect(Number.isNaN(summary.kpis.estimatedMrr)).toBe(false);
    });

    it('treats a null decimal amount with no unitAmount as zero', async () => {
      prisma.plan.findMany.mockResolvedValue([PLAN]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({
          items: [item({ unitAmount: null, unitAmountDecimal: null })],
        }),
      ]);

      const summary = await service.getSummary();
      expect(summary.kpis.estimatedMrr).toBe(0);
    });

    it('falls back to the plan price when a subscription carries no Stripe items', async () => {
      prisma.plan.findMany.mockResolvedValue([PLAN]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ items: [] }),
      ]);

      const summary = await service.getSummary();
      expect(summary.kpis.estimatedMrr).toBe(PLAN.priceMonthly);
    });

    it('uses the yearly plan price for a yearly subscription with no items', async () => {
      prisma.plan.findMany.mockResolvedValue([PLAN]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ billingInterval: 'YEARLY', items: [] }),
      ]);

      const summary = await service.getSummary();
      expect(summary.kpis.estimatedArr).toBe(PLAN.priceYearly);
    });

    it('falls back to the plan id when the plan has no Stripe price configured', async () => {
      const unpricedPlan = {
        ...PLAN,
        stripePriceIdMonthly: null,
        stripePriceIdYearly: null,
      };
      prisma.plan.findMany.mockResolvedValue([unpricedPlan]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ plan: unpricedPlan, items: [] }),
      ]);

      const summary = await service.getSummary();
      expect(summary.revenueByPrice[0].stripePriceId).toBe(unpricedPlan.id);
    });

    it('inherits the subscription billing interval when an item does not state one', async () => {
      prisma.plan.findMany.mockResolvedValue([PLAN]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({
          billingInterval: 'YEARLY',
          items: [item({ billingInterval: null, unitAmount: 120000 })],
        }),
      ]);

      const summary = await service.getSummary();
      expect(summary.kpis.estimatedMrr).toBe(10000);
    });

    it('counts only ACTIVE subscriptions toward revenue', async () => {
      prisma.plan.findMany.mockResolvedValue([PLAN]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ id: 'a', items: [item({ unitAmount: 10000 })] }),
        subscription({
          id: 'b',
          status: SubscriptionStatus.TRIALING,
          items: [item({ unitAmount: 99999 })],
        }),
        subscription({
          id: 'c',
          status: SubscriptionStatus.CANCELED,
          items: [item({ unitAmount: 88888 })],
        }),
      ]);

      const summary = await service.getSummary();
      expect(summary.kpis.estimatedMrr).toBe(10000);
    });
  });

  // ── Currency handling ──────────────────────────────────────────────────────

  describe('currency', () => {
    it('reports the highest-revenue currency as the primary one', async () => {
      prisma.plan.findMany.mockResolvedValue([PLAN]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({
          id: 'a',
          items: [item({ currency: 'BRL', unitAmount: 1000 })],
        }),
        subscription({
          id: 'b',
          items: [item({ currency: 'USD', unitAmount: 9000 })],
        }),
      ]);

      const summary = await service.getSummary();

      expect(summary.kpis.currency).toBe('USD');
      expect(summary.kpis.estimatedMrr).toBe(9000);
      expect(summary.revenueByCurrency.map((row) => row.currency)).toEqual([
        'USD',
        'BRL',
      ]);
    });

    it('never sums across currencies in the headline figure', async () => {
      prisma.plan.findMany.mockResolvedValue([PLAN]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({
          id: 'a',
          items: [item({ currency: 'BRL', unitAmount: 1000 })],
        }),
        subscription({
          id: 'b',
          items: [item({ currency: 'USD', unitAmount: 9000 })],
        }),
      ]);

      const summary = await service.getSummary();
      expect(summary.kpis.estimatedMrr).not.toBe(10000);
    });

    it('defaults a blank item currency to BRL', async () => {
      prisma.plan.findMany.mockResolvedValue([PLAN]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ items: [item({ currency: '' })] }),
      ]);

      const summary = await service.getSummary();
      expect(summary.kpis.currency).toBe('BRL');
    });

    it('reports BRL when the platform has no revenue at all', async () => {
      const summary = await service.getSummary();
      expect(summary.kpis.currency).toBe('BRL');
      expect(summary.kpis.estimatedMrr).toBe(0);
      expect(summary.kpis.estimatedArr).toBe(0);
    });

    it('falls back to the primary currency for a plan billed in several', async () => {
      prisma.plan.findMany.mockResolvedValue([PLAN]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({
          id: 'a',
          items: [item({ currency: 'BRL', unitAmount: 9000 })],
        }),
        subscription({
          id: 'b',
          items: [item({ currency: 'USD', unitAmount: 1000 })],
        }),
      ]);

      const summary = await service.getSummary();
      expect(summary.subscriptionsByPlan[0].currency).toBe('BRL');
    });
  });

  // ── Aggregation by plan and price ──────────────────────────────────────────

  describe('breakdowns', () => {
    it('counts each subscription status per plan', async () => {
      prisma.plan.findMany.mockResolvedValue([PLAN]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ id: 'a', status: SubscriptionStatus.ACTIVE }),
        subscription({ id: 'b', status: SubscriptionStatus.TRIALING }),
        subscription({ id: 'c', status: SubscriptionStatus.CANCELED }),
        subscription({ id: 'd', status: SubscriptionStatus.PAST_DUE }),
        subscription({ id: 'e', status: SubscriptionStatus.UNPAID }),
      ]);

      const summary = await service.getSummary();
      const plan = summary.subscriptionsByPlan[0];

      expect(plan.activeSubscriptions).toBe(1);
      expect(plan.trialSubscriptions).toBe(1);
      expect(plan.canceledSubscriptions).toBe(1);
      // PAST_DUE and UNPAID are both "payment is failing".
      expect(plan.pastDueSubscriptions).toBe(2);
      expect(plan.totalSubscriptions).toBe(5);
    });

    it('rolls PAST_DUE and UNPAID together in the headline KPIs', async () => {
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ id: 'd', status: SubscriptionStatus.PAST_DUE }),
        subscription({ id: 'e', status: SubscriptionStatus.UNPAID }),
      ]);

      const summary = await service.getSummary();
      expect(summary.kpis.pastDueSubscriptions).toBe(2);
    });

    it('reports every known status in the distribution, including the empty ones', async () => {
      const summary = await service.getSummary();

      expect(
        summary.statusDistribution.map((row) => row.status).sort(),
      ).toEqual(Object.values(SubscriptionStatus).sort());
      expect(summary.statusDistribution.every((row) => row.count === 0)).toBe(
        true,
      );
    });

    it('groups revenue by price and counts distinct subscribers', async () => {
      prisma.plan.findMany.mockResolvedValue([PLAN]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ id: 'a', items: [item({ unitAmount: 10000 })] }),
        subscription({
          id: 'b',
          items: [item({ id: 'i2', unitAmount: 10000 })],
        }),
      ]);

      const summary = await service.getSummary();

      expect(summary.revenueByPrice).toHaveLength(1);
      expect(summary.revenueByPrice[0].subscriberCount).toBe(2);
      expect(summary.revenueByPrice[0].estimatedMrr).toBe(20000);
    });

    it('keeps the same price id separate per currency', async () => {
      prisma.plan.findMany.mockResolvedValue([PLAN]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ id: 'a', items: [item({ currency: 'BRL' })] }),
        subscription({ id: 'b', items: [item({ currency: 'USD' })] }),
      ]);

      const summary = await service.getSummary();
      expect(summary.revenueByPrice).toHaveLength(2);
    });

    it('counts a subscription once per plan even with several priced items', async () => {
      prisma.plan.findMany.mockResolvedValue([PLAN]);
      prisma.subscription.findMany.mockResolvedValue([
        subscription({
          items: [
            item({ id: 'i1', stripePriceId: 'price_a' }),
            item({ id: 'i2', stripePriceId: 'price_b' }),
          ],
        }),
      ]);

      const summary = await service.getSummary();
      expect(summary.subscriptionsByPlan[0].subscriberCount).toBe(1);
    });

    it('counts active plans separately from total plans', async () => {
      prisma.plan.findMany.mockResolvedValue([
        PLAN,
        { ...PLAN, id: 'plan-old', isActive: false },
      ]);

      const summary = await service.getSummary();
      expect(summary.kpis.totalPlans).toBe(2);
      expect(summary.kpis.activePlans).toBe(1);
    });
  });

  // ── Recent activity ────────────────────────────────────────────────────────

  describe('recent activity', () => {
    it('lists the newest subscriptions first, capped at eight', async () => {
      prisma.subscription.findMany.mockResolvedValue(
        Array.from({ length: 12 }, (_, i) =>
          subscription({
            id: `sub-${i}`,
            createdAt: new Date(2026, 0, i + 1),
          }),
        ),
      );

      const summary = await service.getSummary();

      expect(summary.recentlyCreatedSubscriptions).toHaveLength(8);
      expect(summary.recentlyCreatedSubscriptions[0].id).toBe('sub-11');
    });

    it('includes only subscriptions that actually ended in the cancellation list', async () => {
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ id: 'live' }),
        subscription({ id: 'canceled', canceledAt: new Date('2026-03-01') }),
        subscription({ id: 'ended', endedAt: new Date('2026-02-01') }),
      ]);

      const summary = await service.getSummary();

      expect(summary.recentlyCanceledSubscriptions.map((s) => s.id)).toEqual([
        'canceled',
        'ended',
      ]);
    });

    it('orders cancellations by when they ended, not when they were created', async () => {
      prisma.subscription.findMany.mockResolvedValue([
        subscription({
          id: 'older-cancel',
          createdAt: new Date('2026-05-01'),
          canceledAt: new Date('2026-01-01'),
        }),
        subscription({
          id: 'newer-cancel',
          createdAt: new Date('2026-01-01'),
          canceledAt: new Date('2026-06-01'),
        }),
      ]);

      const summary = await service.getSummary();
      expect(summary.recentlyCanceledSubscriptions[0].id).toBe('newer-cancel');
    });

    it('falls back to updatedAt when a subscription has neither cancel nor end date', async () => {
      // Reachable when the filter matched on one field and the sort reads the
      // other; the fallback keeps the comparison total.
      prisma.subscription.findMany.mockResolvedValue([
        subscription({
          id: 'x',
          endedAt: new Date('2026-01-01'),
          canceledAt: null,
        }),
      ]);

      const summary = await service.getSummary();
      expect(summary.recentlyCanceledSubscriptions).toHaveLength(1);
    });

    it('exposes no clinic data beyond id, name and email in a preview', async () => {
      prisma.subscription.findMany.mockResolvedValue([subscription()]);

      const summary = await service.getSummary();
      expect(
        Object.keys(summary.recentlyCreatedSubscriptions[0].clinic).sort(),
      ).toEqual(['email', 'id', 'name']);
    });

    it('defaults a preview currency to BRL when the subscription has no items', async () => {
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ items: [] }),
      ]);

      const summary = await service.getSummary();
      expect(summary.recentlyCreatedSubscriptions[0].currency).toBe('BRL');
    });
  });

  // ── Stripe event counters ──────────────────────────────────────────────────

  describe('Stripe event health', () => {
    it('counts processed and failed events separately from the total', async () => {
      prisma.stripeEvent.count
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(90)
        .mockResolvedValueOnce(4);

      const summary = await service.getSummary();

      expect(summary.kpis.stripeEventsTotal).toBe(100);
      expect(summary.kpis.stripeEventsProcessed).toBe(90);
      expect(summary.kpis.stripeEventsFailed).toBe(4);
    });

    it('counts an event as failed only when it is unprocessed and recorded an error', async () => {
      await service.getSummary();

      const failedCall = (prisma.stripeEvent.count as Mock).mock.calls[2][0];
      expect(failedCall.where).toEqual({
        processed: false,
        errorMessage: { not: null },
      });
    });
  });

  // ── listSubscriptions ──────────────────────────────────────────────────────

  describe('listSubscriptions', () => {
    it('filters by a known status', async () => {
      await service.listSubscriptions({ page: 1, limit: 20, status: 'ACTIVE' });

      const where = (prisma.subscription.findMany as Mock).mock.calls[0][0]
        .where;
      expect(where.status).toBe('ACTIVE');
    });

    it('ignores an unrecognised status rather than returning nothing', async () => {
      await service.listSubscriptions({
        page: 1,
        limit: 20,
        status: 'NOT_A_STATUS',
      });

      const where = (prisma.subscription.findMany as Mock).mock.calls[0][0]
        .where;
      expect(where).not.toHaveProperty('status');
    });

    it('filters by plan', async () => {
      await service.listSubscriptions({
        page: 1,
        limit: 20,
        planId: 'plan-pro',
      });

      const where = (prisma.subscription.findMany as Mock).mock.calls[0][0]
        .where;
      expect(where.planId).toBe('plan-pro');
    });

    it('searches clinic names case-insensitively, trimming the term', async () => {
      await service.listSubscriptions({
        page: 1,
        limit: 20,
        search: '  alpha  ',
      });

      const where = (prisma.subscription.findMany as Mock).mock.calls[0][0]
        .where;
      expect(where.clinic).toEqual({
        name: { contains: 'alpha', mode: 'insensitive' },
      });
    });

    it('ignores a whitespace-only search term', async () => {
      await service.listSubscriptions({ page: 1, limit: 20, search: '   ' });

      const where = (prisma.subscription.findMany as Mock).mock.calls[0][0]
        .where;
      expect(where).not.toHaveProperty('clinic');
    });

    it('applies Brazil-midnight boundaries to a date range', async () => {
      await service.listSubscriptions({
        page: 1,
        limit: 20,
        from: '2026-06-01',
        to: '2026-06-30',
      });

      const where = (prisma.subscription.findMany as Mock).mock.calls[0][0]
        .where;
      // Brazil is UTC-3, so a Brazil-midnight start is 03:00 UTC.
      expect(where.createdAt.gte.toISOString()).toBe(
        '2026-06-01T03:00:00.000Z',
      );
      expect(where.createdAt.lt).toBeInstanceOf(Date);
    });

    it('accepts an open-ended range', async () => {
      await service.listSubscriptions({
        page: 1,
        limit: 20,
        from: '2026-06-01',
      });

      const where = (prisma.subscription.findMany as Mock).mock.calls[0][0]
        .where;
      expect(where.createdAt).toHaveProperty('gte');
      expect(where.createdAt).not.toHaveProperty('lt');
    });

    it('omits the date filter entirely when neither bound is supplied', async () => {
      await service.listSubscriptions({ page: 1, limit: 20 });

      const where = (prisma.subscription.findMany as Mock).mock.calls[0][0]
        .where;
      expect(where).not.toHaveProperty('createdAt');
    });

    it('runs the page and its count in one transaction so the total matches the rows', async () => {
      await service.listSubscriptions({ page: 1, limit: 20 });
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it.each([
      [0, 1],
      [-5, 1],
      [Number.NaN, 1],
      [3, 3],
    ])('normalises page %p to %p', async (input, expected) => {
      const result = await service.listSubscriptions({
        page: input,
        limit: 20,
      });
      expect(result.page).toBe(expected);
    });

    it.each([
      [0, 20],
      [-1, 20],
      [Number.NaN, 20],
      [1000, 100],
      [50, 50],
    ])('normalises limit %p to %p', async (input, expected) => {
      const result = await service.listSubscriptions({ page: 1, limit: input });
      expect(result.limit).toBe(expected);
    });

    it('skips by the normalised page and limit', async () => {
      await service.listSubscriptions({ page: 3, limit: 10 });

      const args = (prisma.subscription.findMany as Mock).mock.calls[0][0];
      expect(args.skip).toBe(20);
      expect(args.take).toBe(10);
    });

    it('caps the skip using the capped limit, not the requested one', async () => {
      await service.listSubscriptions({ page: 2, limit: 500 });

      const args = (prisma.subscription.findMany as Mock).mock.calls[0][0];
      expect(args.take).toBe(100);
      expect(args.skip).toBe(100);
    });

    it('returns a stable row shape', async () => {
      prisma.subscription.findMany.mockResolvedValue([
        subscription({ items: [item()] }),
      ]);
      prisma.subscription.count.mockResolvedValue(1);

      const result = await service.listSubscriptions({ page: 1, limit: 20 });

      expect(Object.keys(result.data[0]).sort()).toEqual([
        'cancelAtPeriodEnd',
        'canceledAt',
        'clinic',
        'createdAt',
        'currentPeriodEnd',
        'currentPeriodStart',
        'endedAt',
        'id',
        'items',
        'plan',
        'status',
        'trialEndsAt',
        'updatedAt',
      ]);
      expect(result.total).toBe(1);
    });
  });

  // ── listPlans ──────────────────────────────────────────────────────────────

  describe('listPlans', () => {
    it('counts total, active and trialing subscriptions per plan', async () => {
      prisma.plan.findMany.mockResolvedValue([
        {
          ...PLAN,
          subscriptions: [
            { status: SubscriptionStatus.ACTIVE },
            { status: SubscriptionStatus.ACTIVE },
            { status: SubscriptionStatus.TRIALING },
            { status: SubscriptionStatus.CANCELED },
          ],
        },
      ]);

      const [plan] = await service.listPlans();

      expect(plan.subscriptionsCount).toBe(4);
      expect(plan.activeSubscriptionsCount).toBe(2);
      expect(plan.trialSubscriptionsCount).toBe(1);
    });

    it('reports zero counts for a plan nobody subscribes to', async () => {
      prisma.plan.findMany.mockResolvedValue([{ ...PLAN, subscriptions: [] }]);

      const [plan] = await service.listPlans();
      expect(plan.subscriptionsCount).toBe(0);
      expect(plan.activeSubscriptionsCount).toBe(0);
    });

    it('orders by display order then name', async () => {
      await service.listPlans();

      const args = (prisma.plan.findMany as Mock).mock.calls[0][0];
      expect(args.orderBy).toEqual([{ displayOrder: 'asc' }, { name: 'asc' }]);
    });

    it('does not leak the raw subscription rows it counted', async () => {
      prisma.plan.findMany.mockResolvedValue([
        { ...PLAN, subscriptions: [{ status: SubscriptionStatus.ACTIVE }] },
      ]);

      const [plan] = await service.listPlans();
      expect(plan).not.toHaveProperty('subscriptions');
    });
  });

  // ── listStripeEvents ───────────────────────────────────────────────────────

  describe('listStripeEvents', () => {
    it('filters to processed events', async () => {
      await service.listStripeEvents({ page: 1, limit: 20, processed: 'true' });

      const where = (prisma.stripeEvent.findMany as Mock).mock.calls[0][0]
        .where;
      expect(where.processed).toBe(true);
    });

    it('filters to unprocessed events', async () => {
      await service.listStripeEvents({
        page: 1,
        limit: 20,
        processed: 'false',
      });

      const where = (prisma.stripeEvent.findMany as Mock).mock.calls[0][0]
        .where;
      expect(where.processed).toBe(false);
    });

    it('ignores any other value of the processed filter', async () => {
      await service.listStripeEvents({
        page: 1,
        limit: 20,
        processed: 'maybe',
      });

      const where = (prisma.stripeEvent.findMany as Mock).mock.calls[0][0]
        .where;
      expect(where).not.toHaveProperty('processed');
    });

    it('searches event types case-insensitively', async () => {
      await service.listStripeEvents({
        page: 1,
        limit: 20,
        type: ' invoice. ',
      });

      const where = (prisma.stripeEvent.findMany as Mock).mock.calls[0][0]
        .where;
      expect(where.type).toEqual({ contains: 'invoice.', mode: 'insensitive' });
    });

    it('ignores a whitespace-only type filter', async () => {
      await service.listStripeEvents({ page: 1, limit: 20, type: '  ' });

      const where = (prisma.stripeEvent.findMany as Mock).mock.calls[0][0]
        .where;
      expect(where).not.toHaveProperty('type');
    });

    it('filters on receivedAt rather than createdAt', async () => {
      await service.listStripeEvents({
        page: 1,
        limit: 20,
        from: '2026-06-01',
      });

      const where = (prisma.stripeEvent.findMany as Mock).mock.calls[0][0]
        .where;
      expect(where).toHaveProperty('receivedAt');
      expect(where).not.toHaveProperty('createdAt');
    });

    it('orders newest received first', async () => {
      await service.listStripeEvents({ page: 1, limit: 20 });

      const args = (prisma.stripeEvent.findMany as Mock).mock.calls[0][0];
      expect(args.orderBy).toEqual([{ receivedAt: 'desc' }]);
    });

    it('returns the diagnostic fields an operator needs, and no payload', async () => {
      prisma.stripeEvent.findMany.mockResolvedValue([
        {
          id: 'evt_1',
          type: 'invoice.paid',
          processed: true,
          processedAt: new Date('2026-06-01'),
          errorMessage: null,
          createdAt: new Date('2026-06-01'),
          receivedAt: new Date('2026-06-01'),
          payload: { secret: 'should not be exposed' },
        },
      ]);

      const result = await service.listStripeEvents({ page: 1, limit: 20 });

      expect(Object.keys(result.data[0]).sort()).toEqual([
        'createdAt',
        'errorMessage',
        'id',
        'processed',
        'processedAt',
        'receivedAt',
        'type',
      ]);
      expect(JSON.stringify(result.data)).not.toContain(
        'should not be exposed',
      );
    });
  });
});
