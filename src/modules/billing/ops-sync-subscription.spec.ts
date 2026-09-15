import { BillingInterval } from '@prisma/client';

import {
  buildSubscriptionData,
  type LocalContext,
  type ResolvedStripeTarget,
  type StripeSubscription,
} from '../../../scripts/ops/sync-stripe-subscription';

/**
 * The operational reconciliation runbook writes the same subscription columns
 * the webhook does, so it has to agree with it about a scheduled cancellation.
 * It did not: it read `cancel_at_period_end` directly, and a hosted-portal
 * cancellation leaves that false. Run against a clinic that had cancelled
 * through the portal, it would have reset cancelAtPeriodEnd to false and
 * undone the fix the request path already makes correctly.
 *
 * Importing this module is safe — the script only reconciles when invoked
 * directly, so nothing here touches Stripe or a database.
 */

const LOCAL: LocalContext = {
  clinicId: 'clinic-1',
  planId: 'plan-1',
  billingInterval: BillingInterval.MONTHLY,
};

function target(
  overrides: Partial<StripeSubscription> = {},
): ResolvedStripeTarget {
  return {
    customer: { id: 'cus_1' },
    subscription: {
      id: 'sub_1',
      status: 'active',
      created: 1_789_000_000,
      customer: 'cus_1',
      items: {
        data: [
          {
            id: 'si_1',
            current_period_start: 1_789_000_000,
            current_period_end: 1_791_000_000,
            price: {
              id: 'price_1',
              currency: 'brl',
              recurring: { interval: 'month' },
            },
          },
        ],
      },
      trial_end: null,
      cancel_at_period_end: false,
      cancel_at: null,
      canceled_at: null,
      ended_at: null,
      ...overrides,
    },
  };
}

describe('sync-stripe-subscription — scheduled cancellation mapping', () => {
  it('keeps a hosted-portal cancellation, which sets only cancel_at', () => {
    const data = buildSubscriptionData(
      target({
        status: 'active',
        cancel_at_period_end: false,
        cancel_at: 1_791_000_000,
        canceled_at: 1_789_500_000,
        ended_at: null,
      }),
      LOCAL,
    );

    expect(data.cancelAtPeriodEnd).toBe(true);
  });

  it('keeps a traditional in-app cancellation', () => {
    const data = buildSubscriptionData(
      target({ cancel_at_period_end: true, canceled_at: 1_789_500_000 }),
      LOCAL,
    );

    expect(data.cancelAtPeriodEnd).toBe(true);
  });

  it('leaves an ordinary renewing subscription unflagged', () => {
    expect(buildSubscriptionData(target(), LOCAL).cancelAtPeriodEnd).toBe(
      false,
    );
  });

  it('does not describe an ended subscription as scheduled', () => {
    const data = buildSubscriptionData(
      target({
        status: 'canceled',
        cancel_at: 1_789_000_000,
        canceled_at: 1_789_000_000,
        ended_at: 1_789_000_000,
      }),
      LOCAL,
    );

    expect(data.cancelAtPeriodEnd).toBe(false);
  });

  it('still carries the rest of the reconciled state', () => {
    const data = buildSubscriptionData(target(), LOCAL);

    expect(data).toMatchObject({
      clinicId: 'clinic-1',
      planId: 'plan-1',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      billingInterval: BillingInterval.MONTHLY,
    });
    expect(data.currentPeriodEnd).toEqual(new Date(1_791_000_000 * 1000));
  });
});
