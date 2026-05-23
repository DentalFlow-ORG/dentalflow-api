import { BillingInterval, SubscriptionStatus } from '@prisma/client';

import {
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
