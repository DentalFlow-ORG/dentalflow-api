import { BillingInterval, SubscriptionStatus } from '@prisma/client';

import {
  hasScheduledCancellation,
  mapStripePriceInterval,
  mapStripeSubscriptionStatus,
} from './billing-stripe-mappers';

describe('mapStripeSubscriptionStatus', () => {
  it.each([
    ['trialing', SubscriptionStatus.TRIALING],
    ['active', SubscriptionStatus.ACTIVE],
    ['past_due', SubscriptionStatus.PAST_DUE],
    ['canceled', SubscriptionStatus.CANCELED],
    ['unpaid', SubscriptionStatus.UNPAID],
    ['paused', SubscriptionStatus.PAUSED],
    ['incomplete', SubscriptionStatus.INCOMPLETE],
  ] as const)(
    'maps Stripe status "%s" to SubscriptionStatus.%s',
    (stripeStatus, expected) => {
      expect(mapStripeSubscriptionStatus(stripeStatus)).toBe(expected);
    },
  );

  it('maps "incomplete_expired" to CANCELED (never activated)', () => {
    expect(mapStripeSubscriptionStatus('incomplete_expired')).toBe(
      SubscriptionStatus.CANCELED,
    );
  });

  it('falls back to INCOMPLETE for unknown Stripe status strings', () => {
    expect(mapStripeSubscriptionStatus('unknown_future_status')).toBe(
      SubscriptionStatus.INCOMPLETE,
    );
  });
});

describe('mapStripePriceInterval', () => {
  it('maps "month" to BillingInterval.MONTHLY', () => {
    expect(mapStripePriceInterval('month')).toBe(BillingInterval.MONTHLY);
  });

  it('maps "year" to BillingInterval.YEARLY', () => {
    expect(mapStripePriceInterval('year')).toBe(BillingInterval.YEARLY);
  });

  it('returns null for null input', () => {
    expect(mapStripePriceInterval(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(mapStripePriceInterval(undefined)).toBeNull();
  });

  it('returns null for unknown interval strings', () => {
    expect(mapStripePriceInterval('week')).toBeNull();
  });
});

describe('hasScheduledCancellation', () => {
  function subscription(overrides: Record<string, unknown> = {}) {
    return {
      status: 'active',
      cancel_at_period_end: false,
      cancel_at: null,
      ended_at: null,
      ...overrides,
    };
  }

  it('reports no cancellation for an ordinary renewing subscription', () => {
    expect(hasScheduledCancellation(subscription())).toBe(false);
  });

  it('reports the in-app shape, which sets cancel_at_period_end', () => {
    expect(
      hasScheduledCancellation(
        subscription({ cancel_at_period_end: true, cancel_at: 1_791_000_000 }),
      ),
    ).toBe(true);
  });

  it('reports the hosted-portal shape, which sets only cancel_at', () => {
    expect(
      hasScheduledCancellation(
        subscription({ cancel_at_period_end: false, cancel_at: 1_791_000_000 }),
      ),
    ).toBe(true);
  });

  it('reports nothing once the subscription has actually ended', () => {
    expect(
      hasScheduledCancellation(
        subscription({
          status: 'canceled',
          cancel_at: 1_789_000_000,
          ended_at: 1_789_000_000,
        }),
      ),
    ).toBe(false);
  });

  it.each(['canceled', 'incomplete_expired'])(
    'reports nothing for terminal status "%s" even before ended_at arrives',
    (status) => {
      expect(
        hasScheduledCancellation(
          subscription({ status, cancel_at: 1_789_000_000 }),
        ),
      ).toBe(false);
    },
  );

  it('tolerates a Stripe object that omits the optional fields', () => {
    expect(
      hasScheduledCancellation({
        status: 'active',
        cancel_at_period_end: true,
      }),
    ).toBe(true);
    expect(
      hasScheduledCancellation({
        status: 'active',
        cancel_at_period_end: false,
      }),
    ).toBe(false);
  });
});
