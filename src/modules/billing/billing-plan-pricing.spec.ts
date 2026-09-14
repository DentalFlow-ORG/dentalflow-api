import { BillingService } from './billing.service';
import { launchCampaignConfig } from './billing-campaign.config';

/**
 * The plan list a visitor sees, and the checkout success URL Stripe redirects
 * to.
 *
 * Neither had a test, and both are places where an error is silent. A wrong
 * discount is a wrong number on a pricing page; a wrong success URL is a
 * checkout that completes and then cannot be reconciled, because the
 * `{CHECKOUT_SESSION_ID}` placeholder Stripe substitutes was never there — or
 * was percent-encoded on the way out and so never matched.
 *
 * That URL is the one part of the Stripe flow that can be proved here rather
 * than by hand, and it is the first step of the manual QA checklist in
 * AGENTS.md §9. Proving it in a unit test is the difference between a
 * checklist step that catches a typo and one that catches a regression.
 */

const CLINIC = 'clinic-1';

function planRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'plan-1',
    slug: 'professional',
    name: 'Professional',
    priceMonthly: 21_990,
    priceYearly: 219_900,
    stripePriceIdMonthly: 'price_monthly',
    stripePriceIdYearly: 'price_yearly',
    displayOrder: 1,
    ...overrides,
  };
}

function createService(plans = [planRow()]) {
  const prisma = {
    plan: { findMany: jest.fn().mockResolvedValue(plans) },
  };
  const stripe = {} as never;
  return {
    service: new BillingService(prisma as never, stripe),
    prisma,
  };
}

describe('BillingService — the plan list', () => {
  const originalEnabled = launchCampaignConfig.enabled;
  const originalEnd = launchCampaignConfig.promotionEndDate;
  const originalCoupons = launchCampaignConfig.coupons;
  const mutable = launchCampaignConfig as {
    enabled: boolean;
    promotionEndDate: string;
    coupons: Record<string, Partial<Record<'MONTHLY' | 'YEARLY', string>>>;
  };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-01T12:00:00.000Z'));
    mutable.enabled = true;
    mutable.promotionEndDate = '2026-06-01T02:59:59.000Z';
    mutable.coupons = {
      professional: { MONTHLY: 'coupon_professional' },
      starter: {},
    };
  });

  afterEach(() => {
    jest.useRealTimers();
    mutable.enabled = originalEnabled;
    mutable.promotionEndDate = originalEnd;
    mutable.coupons = originalCoupons;
  });

  // ── The annual discount ────────────────────────────────────────────────────

  describe('the annual discount', () => {
    it('is the saving of paying yearly, as a whole percent', async () => {
      const { service } = createService([
        planRow({ priceMonthly: 10_000, priceYearly: 100_000 }),
      ]);

      const result = await service.getPlans();

      // Twelve months at 10 000 is 120 000; paying 100 000 saves ~17%.
      expect(result.plans[0].annualDiscountPercent).toBe(17);
    });

    it('is zero rather than negative when the yearly price is worse', async () => {
      const { service } = createService([
        planRow({ priceMonthly: 10_000, priceYearly: 200_000 }),
      ]);

      const result = await service.getPlans();

      // A negative "discount" on a pricing page reads as a bug to the visitor
      // and as a discount to nobody.
      expect(result.plans[0].annualDiscountPercent).toBe(0);
    });

    it('is absent when either price is missing', async () => {
      const { service } = createService([
        planRow({ priceMonthly: 10_000, priceYearly: 0 }),
      ]);

      const result = await service.getPlans();

      expect(result.plans[0].annualDiscountPercent).toBeNull();
    });
  });

  // ── What the list exposes ──────────────────────────────────────────────────

  describe('the plan payload', () => {
    it('reports whether each interval is purchasable without leaking the price ids', async () => {
      const { service } = createService([
        planRow({ stripePriceIdYearly: null }),
      ]);

      const plan = (await service.getPlans()).plans[0];

      expect(plan.hasMonthlyPrice).toBe(true);
      expect(plan.hasYearlyPrice).toBe(false);
      // The Stripe price ids are internal; the page only needs to know which
      // buttons to render.
      expect(plan).not.toHaveProperty('stripePriceIdMonthly');
      expect(plan).not.toHaveProperty('stripePriceIdYearly');
    });

    it('orders the plans as configured', async () => {
      const { service, prisma } = createService();

      await service.getPlans();

      expect(prisma.plan.findMany.mock.calls[0][0].orderBy).toEqual({
        displayOrder: 'asc',
      });
    });
  });

  // ── The launch campaign ────────────────────────────────────────────────────

  describe('the launch campaign', () => {
    it('is active before the end date', async () => {
      const result = await createService().service.getPlans();

      expect(result.campaign.enabled).toBe(true);
      expect(result.campaign.message).toContain('condição especial');
    });

    it('is over once the end date has passed', async () => {
      jest.setSystemTime(new Date('2026-07-01T12:00:00.000Z'));

      const result = await createService().service.getPlans();

      expect(result.campaign.enabled).toBe(false);
      expect(result.campaign.message).toBe('Oferta encerrada.');
    });

    it('is off when switched off, whatever the date says', async () => {
      mutable.enabled = false;

      const result = await createService().service.getPlans();

      expect(result.campaign.enabled).toBe(false);
    });

    it('is off when the configured end date is unparseable', async () => {
      mutable.promotionEndDate = 'not-a-date';

      // Failing closed matters here: an unreadable date must not leave a
      // promotion running forever.
      const result = await createService().service.getPlans();

      expect(result.campaign.enabled).toBe(false);
    });

    it('reports a plan as promotion-ready only with a coupon configured', async () => {
      const result = await createService().service.getPlans();

      expect(result.plans[0].campaign).toMatchObject({
        enabled: true,
        promotionalPriceMonthly: 18_990,
        promotionReady: true,
        couponConfigured: true,
      });
    });

    it('reports a plan as not ready when its coupon is missing', async () => {
      // The price would be advertised and then not applied at checkout. The
      // flag is what lets the page avoid promising it.
      const { service } = createService([planRow({ slug: 'starter' })]);

      const result = await service.getPlans();

      expect(result.plans[0].campaign).toMatchObject({
        promotionReady: false,
        couponConfigured: false,
      });
    });

    it('reports no plan as ready once the campaign is over', async () => {
      jest.setSystemTime(new Date('2026-07-01T12:00:00.000Z'));

      const result = await createService().service.getPlans();

      expect(result.plans[0].campaign).toMatchObject({
        enabled: false,
        promotionReady: false,
        couponConfigured: false,
      });
    });

    it('compares against the plan’s own price when it has one', async () => {
      const result = await createService().service.getPlans();

      expect(result.plans[0].campaign.compareAtPriceMonthly).toBe(21_990);
    });

    it('falls back to the configured compare-at price for a free plan', async () => {
      const { service } = createService([planRow({ priceMonthly: 0 })]);

      const result = await service.getPlans();

      expect(result.plans[0].campaign.compareAtPriceMonthly).toBe(21_990);
    });

    it('carries no promotional price for a plan the campaign does not cover', async () => {
      const { service } = createService([planRow({ slug: 'enterprise' })]);

      const result = await service.getPlans();

      expect(result.plans[0].campaign.promotionalPriceMonthly).toBeNull();
      expect(result.plans[0].campaign.promotionReady).toBe(false);
    });
  });
});

// ── The checkout success URL ─────────────────────────────────────────────────

/**
 * `buildCheckoutSuccessUrl` reads `STRIPE_SUCCESS_URL` at module load, so each
 * case re-imports the module with a different value and then drives a real
 * checkout to see what Stripe is actually handed.
 */
describe('the checkout success URL', () => {
  const original = process.env.STRIPE_SUCCESS_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.STRIPE_SUCCESS_URL;
    else process.env.STRIPE_SUCCESS_URL = original;
    jest.resetModules();
  });

  /** Runs a checkout with the given configured URL and returns what Stripe got. */
  async function successUrlSentToStripe(
    configured: string | undefined,
  ): Promise<string> {
    jest.resetModules();
    if (configured === undefined) delete process.env.STRIPE_SUCCESS_URL;
    else process.env.STRIPE_SUCCESS_URL = configured;

    const source = await import('./billing.service');

    const sessionCreate = jest
      .fn()
      .mockResolvedValue({ url: 'https://checkout.stripe.test/c/session' });
    const prisma = {
      plan: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'plan-1',
          slug: 'professional',
          stripePriceIdMonthly: 'price_monthly',
          stripePriceIdYearly: 'price_yearly',
        }),
      },
      subscription: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      clinic: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ name: 'Clínica', email: 'c@example.test' }),
      },
    };
    const stripe = {
      getClient: () => ({
        customers: { create: jest.fn().mockResolvedValue({ id: 'cus_1' }) },
        checkout: { sessions: { create: sessionCreate } },
      }),
    };

    const service = new source.BillingService(prisma as never, stripe as never);
    await service.createCheckoutSession(CLINIC, 'user-1', {
      planKey: 'professional',
      billingInterval: 'MONTHLY',
    } as never);

    return (sessionCreate.mock.calls[0][0] as { success_url: string })
      .success_url;
  }

  it('appends the placeholder when the configured URL has none', async () => {
    const sent = await successUrlSentToStripe('https://app.test/assinatura/ok');

    expect(sent).toBe(
      'https://app.test/assinatura/ok?session_id={CHECKOUT_SESSION_ID}',
    );
  });

  it('joins with & when the configured URL already has a query', async () => {
    const sent = await successUrlSentToStripe(
      'https://app.test/ok?from=pricing',
    );

    expect(sent).toBe(
      'https://app.test/ok?from=pricing&session_id={CHECKOUT_SESSION_ID}',
    );
  });

  it('leaves a placeholder the operator positioned themselves', async () => {
    const sent = await successUrlSentToStripe(
      'https://app.test/ok/{CHECKOUT_SESSION_ID}/done',
    );

    expect(sent).toBe('https://app.test/ok/{CHECKOUT_SESSION_ID}/done');
    // Appended a second time, the sync endpoint would read the wrong one.
    expect(sent.match(/\{CHECKOUT_SESSION_ID\}/g)).toHaveLength(1);
  });

  it('sends the braces literally, never percent-encoded', async () => {
    const sent = await successUrlSentToStripe('https://app.test/ok');

    // Stripe substitutes by matching the exact string `{CHECKOUT_SESSION_ID}`.
    // Built through URLSearchParams the braces become %7B…%7D, the
    // substitution never happens, and POST /billing/checkout-session/sync is
    // left with no session id to reconcile — a checkout that completes and is
    // never recorded. This is step three of the manual Stripe checklist in
    // AGENTS.md §9, proved here so the checklist catches regressions rather
    // than typos.
    expect(sent).toContain('{CHECKOUT_SESSION_ID}');
    expect(sent).not.toContain('%7B');
    expect(sent).not.toContain('%7D');
  });

  it('falls back to a local URL that still carries the placeholder', async () => {
    const sent = await successUrlSentToStripe(undefined);

    expect(sent).toContain('{CHECKOUT_SESSION_ID}');
  });
});
