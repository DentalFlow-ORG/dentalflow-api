import { SubscriptionStatus } from '@prisma/client';

import { BillingService } from './billing.service';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const prismaMock = {
  subscription: { findUnique: jest.fn() },
  plan: { findFirst: jest.fn(), findMany: jest.fn() },
  clinic: { findUniqueOrThrow: jest.fn() },
};

const stripeMock = {
  getClient: jest.fn(),
  getWebhookSecret: jest.fn(),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildService(): BillingService {
  return new BillingService(prismaMock as never, stripeMock as never);
}

const CLINIC_ID = 'clinic-1';
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

function baseSub(
  overrides: Partial<{
    status: SubscriptionStatus;
    trialEndsAt: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    plan: { id: string; name: string; slug: string } | null;
  }> = {},
) {
  return {
    id: 'sub-1',
    status: SubscriptionStatus.ACTIVE,
    billingInterval: 'MONTHLY',
    stripeCustomerId: 'cus_test',
    stripeSubscriptionId: 'sub_test',
    trialEndsAt: null,
    currentPeriodEnd: FUTURE,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    endedAt: null,
    plan: { id: 'plan-1', name: 'Professional', slug: 'professional' },
    ...overrides,
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('BillingService.getCurrentSubscriptionStatus', () => {
  let service: BillingService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = buildService();
  });

  it('returns missing status when no subscription exists', async () => {
    prismaMock.subscription.findUnique.mockResolvedValue(null);

    const result = await service.getCurrentSubscriptionStatus(CLINIC_ID);

    expect(result).toMatchObject({
      hasSubscription: false,
      status: 'missing',
      accessAllowed: false,
      requiresPlanSelection: true,
      requiresPayment: false,
    });
  });

  it('returns accessAllowed: true for ACTIVE subscription', async () => {
    prismaMock.subscription.findUnique.mockResolvedValue(
      baseSub({ status: SubscriptionStatus.ACTIVE }),
    );

    const result = await service.getCurrentSubscriptionStatus(CLINIC_ID);

    expect(result).toMatchObject({ accessAllowed: true, status: 'active' });
  });

  it('returns accessAllowed: true for TRIALING subscription with future trialEndsAt', async () => {
    prismaMock.subscription.findUnique.mockResolvedValue(
      baseSub({ status: SubscriptionStatus.TRIALING, trialEndsAt: FUTURE }),
    );

    const result = await service.getCurrentSubscriptionStatus(CLINIC_ID);

    expect(result).toMatchObject({ accessAllowed: true, status: 'trialing' });
  });

  it('returns accessAllowed: false for TRIALING subscription with expired trialEndsAt', async () => {
    prismaMock.subscription.findUnique.mockResolvedValue(
      baseSub({ status: SubscriptionStatus.TRIALING, trialEndsAt: PAST }),
    );

    const result = await service.getCurrentSubscriptionStatus(CLINIC_ID);

    expect(result).toMatchObject({ accessAllowed: false, status: 'trialing' });
  });

  it('returns accessAllowed: false for TRIALING subscription with null trialEndsAt', async () => {
    prismaMock.subscription.findUnique.mockResolvedValue(
      baseSub({ status: SubscriptionStatus.TRIALING, trialEndsAt: null }),
    );

    const result = await service.getCurrentSubscriptionStatus(CLINIC_ID);

    expect(result).toMatchObject({ accessAllowed: false, status: 'trialing' });
  });

  it('returns accessAllowed: true for CANCELED subscription still within grace period', async () => {
    prismaMock.subscription.findUnique.mockResolvedValue(
      baseSub({
        status: SubscriptionStatus.CANCELED,
        currentPeriodEnd: FUTURE,
      }),
    );

    const result = await service.getCurrentSubscriptionStatus(CLINIC_ID);

    expect(result).toMatchObject({ accessAllowed: true, status: 'canceled' });
  });

  it('returns accessAllowed: false for CANCELED subscription after grace period', async () => {
    prismaMock.subscription.findUnique.mockResolvedValue(
      baseSub({ status: SubscriptionStatus.CANCELED, currentPeriodEnd: PAST }),
    );

    const result = await service.getCurrentSubscriptionStatus(CLINIC_ID);

    expect(result).toMatchObject({ accessAllowed: false, status: 'canceled' });
  });

  it.each([
    [SubscriptionStatus.PAST_DUE, 'past_due'],
    [SubscriptionStatus.UNPAID, 'unpaid'],
    [SubscriptionStatus.INCOMPLETE, 'incomplete'],
    [SubscriptionStatus.PAUSED, 'paused'],
  ] as const)(
    'returns accessAllowed: false for %s status',
    async (status, expectedNormalized) => {
      prismaMock.subscription.findUnique.mockResolvedValue(baseSub({ status }));

      const result = await service.getCurrentSubscriptionStatus(CLINIC_ID);

      expect(result).toMatchObject({
        accessAllowed: false,
        status: expectedNormalized,
      });
    },
  );

  it('includes plan key and name when subscription has a plan', async () => {
    prismaMock.subscription.findUnique.mockResolvedValue(
      baseSub({ plan: { id: 'plan-1', name: 'Premium', slug: 'premium' } }),
    );

    const result = await service.getCurrentSubscriptionStatus(CLINIC_ID);

    expect(result).toMatchObject({ planKey: 'premium', planName: 'Premium' });
  });

  it('sets requiresPayment: true when access is denied and subscription exists', async () => {
    prismaMock.subscription.findUnique.mockResolvedValue(
      baseSub({ status: SubscriptionStatus.PAST_DUE }),
    );

    const result = await service.getCurrentSubscriptionStatus(CLINIC_ID);

    expect(result).toMatchObject({
      requiresPlanSelection: false,
      requiresPayment: true,
    });
  });
});
